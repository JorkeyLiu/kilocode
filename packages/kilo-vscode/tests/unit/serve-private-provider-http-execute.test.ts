import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ServePrivatePeer } from "../../src/services/cli-backend/serve-private-peer"
import { PROVIDER_HTTP_EXECUTE_METHOD } from "../../src/services/cli-backend/serve-private-provider-http-execute"
import { ErrorCode } from "../../src/private-worker/json-rpc"

function linkedPair(deps: { resolveSecret: (ref: string) => Promise<string | undefined> }) {
  const hostToClient = new PassThrough()
  const clientToHost = new PassThrough()
  const hostPeer = new ServePrivatePeer({
    reader: clientToHost,
    writer: hostToClient,
    pid: 701,
    epoch: 71,
    providerExecuteDeps: deps,
    providerHttpExecuteDeps: deps,
    initializeTimeoutMs: 500,
  })
  const clientPeer = new JsonRpcPeer({
    reader: hostToClient,
    writer: clientToHost,
    onRequest: async (method: string) => {
      if (method === "initialize")
        return {
          protocol: { name: "kilo-private", major: 1, minor: 0 },
          serverInfo: { name: "kilo", version: "1" },
          capabilities: ["session/cancelQueued"],
        }
      const err = new Error(`Method not found: ${method}`) as Error & { code?: number }
      err.code = ErrorCode.MethodNotFound
      throw err
    },
  })
  return { hostPeer, clientPeer, hostToClient, clientToHost }
}

function disposeLink(link: { hostPeer: ServePrivatePeer; clientPeer: JsonRpcPeer; hostToClient: PassThrough; clientToHost: PassThrough }) {
  try { link.hostPeer.dispose() } catch {}
  try { link.clientPeer.dispose() } catch {}
  try { link.hostToClient.destroy() } catch {}
  try { link.clientToHost.destroy() } catch {}
}

const record = (endpoint: string, protocol: "openai/completions" | "anthropic/messages", ref: string) => ({
  name: "Acme",
  endpoint,
  protocol,
  models: { m1: { name: "M1" } },
  credential: ref,
})

describe("provider/httpExecute streaming", () => {
  test("end-to-end streaming observes injected secret and fixed route, strips caller headers, reconstructs bytes", async () => {
    const seen: { path: string; auth: string | null; apiKey: string | null; body: string; headers: Record<string, string> } = {
      path: "",
      auth: null,
      apiKey: null,
      body: "",
      headers: {},
    }
    const payload = "hello world streaming bytes"
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url)
        seen.path = url.pathname
        seen.auth = req.headers.get("authorization")
        seen.apiKey = req.headers.get("x-api-key")
        seen.headers = Object.fromEntries(req.headers.entries())
        seen.body = await req.text()
        return new Response(payload, { status: 200, headers: { "content-type": "text/plain", "x-custom": "ok" } })
      },
    })
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async (r: string) => (r === ref ? "sk-live" : undefined) }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const body = JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] })
        const params = { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), body, headers: { "x-custom": "from-cli" } }
        const events: unknown[] = []
        const { id, promise } = link.clientPeer.requestWithId(PROVIDER_HTTP_EXECUTE_METHOD, params, (ev) => events.push(ev))
        // ensure id allocated
        expect(typeof id).toBe("number")
        const result = (await promise) as { seq: number; chunks: number; bytes: number }
        expect(events.length).toBeGreaterThanOrEqual(1)
        const meta = events[0] as { seq: number; status: number; headers: Record<string, string> }
        expect(meta.seq).toBe(0)
        expect(meta.status).toBe(200)
        expect(meta.headers["x-custom"]).toBe("ok")
        // headers should not contain auth
        expect(JSON.stringify(meta.headers).toLowerCase().includes("authorization")).toBeFalse()
        // caller header should not have been sent to server (we sent x-custom from host? Actually cli's x-custom should be forwarded, but forbidden headers not)
        expect(seen.headers["authorization"]).toBe("Bearer sk-live")
        expect(seen.headers["x-custom"]).toBe("from-cli")
        expect(seen.path).toBe("/chat/completions")
        expect(seen.body).toBe(body)
        // Reconstruct bytes
        let total = 0
        for (let i = 1; i < events.length; i++) {
          const chunk = events[i] as { seq: number; bytes: string }
          expect(chunk.seq).toBe(i)
          const decoded = Buffer.from(chunk.bytes, "base64").toString("utf8")
          total += Buffer.from(chunk.bytes, "base64").length
        }
        expect(result.seq).toBe(events.length - 1)
        expect(result.chunks).toBe(events.length - 1)
        expect(result.bytes).toBe(total)
        // Concatenate
        const out = Buffer.concat(events.slice(1).map((e) => Buffer.from((e as { bytes: string }).bytes, "base64"))).toString("utf8")
        expect(out).toBe(payload)
      } finally {
        disposeLink(link)
      }
    } finally {
      server.stop()
    }
  })

  test("rejects caller-sensitive headers before network", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => new Response("ok", { status: 200 }),
    })
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async () => "sk" }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const body = JSON.stringify({ model: "m1", messages: [] })
        const bad = { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), body, headers: { authorization: "Bearer evil" } }
        let code: number | undefined
        try {
          await link.clientPeer.request(PROVIDER_HTTP_EXECUTE_METHOD, bad)
        } catch (e) {
          code = (e as { code?: number }).code
        }
        expect(code).toBe(ErrorCode.InvalidParams)
      } finally {
        disposeLink(link)
      }
    } finally {
      server.stop()
    }
  })

  test("wrong model/body model fails closed", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => new Response("ok") })
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async () => "sk" }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const body = JSON.stringify({ model: "other", messages: [] })
        let code: number | undefined
        try {
          await link.clientPeer.request(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), body })
        } catch (e) {
          code = (e as { code?: number }).code
        }
        expect(code).toBe(ErrorCode.InvalidParams)
      } finally {
        disposeLink(link)
      }
    } finally {
      server.stop()
    }
  })

  test("cancellation aborts host fetch and cleans state", async () => {
    let aborted = false
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const sig = req.signal
        sig.addEventListener("abort", () => { aborted = true }, { once: true })
        await new Promise((r) => setTimeout(r, 500))
        if (sig.aborted) aborted = true
        return new Response("late", { status: 200 })
      },
    })
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async () => "sk" }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const body = JSON.stringify({ model: "m1", messages: [] })
        const { id, promise } = link.clientPeer.requestWithId(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), body })
        setTimeout(() => link.clientPeer.cancel(id), 100)
        let threw = false
        try { await promise } catch { threw = true }
        expect(threw).toBeTrue()
        await new Promise((r) => setTimeout(r, 200))
        expect(aborted).toBeTrue()
        const peer = (link.hostPeer as unknown as { peer: JsonRpcPeer | null }).peer
        expect(peer?.getIncomingCount()).toBe(0)
      } finally {
        disposeLink(link)
      }
    } finally {
      server.stop()
    }
  })

  test("unsupported protocol and malformed record fail closed before network", async () => {
    const seen = { hit: false }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        seen.hit = true
        return new Response("ok")
      },
    })
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async () => "sk" }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const body = JSON.stringify({ model: "m1" })
        // unknown protocol
        let code: number | undefined
        try {
          await link.clientPeer.request(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: { ...record(endpoint, "openai/completions", ref), protocol: "unknown" }, body })
        } catch (e) { code = (e as { code?: number }).code }
        expect(code).toBe(ErrorCode.InvalidParams)
        expect(seen.hit).toBeFalse()
        // extra key
        seen.hit = false
        try {
          await link.clientPeer.request(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: { ...record(endpoint, "openai/completions", ref), extra: 1 }, body })
        } catch (e) { code = (e as { code?: number }).code }
        expect(code).toBe(ErrorCode.InvalidParams)
        expect(seen.hit).toBeFalse()
      } finally {
        disposeLink(link)
      }
    } finally {
      server.stop()
    }
  })

  test("anthropic route uses x-api-key and /messages path, sanitizes response headers", async () => {
    const seen: { path: string; apiKey: string | null; auth: string | null } = { path: "", apiKey: null, auth: null }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        seen.path = new URL(req.url).pathname
        seen.apiKey = req.headers.get("x-api-key")
        seen.auth = req.headers.get("authorization")
        return new Response("ok", { status: 201, headers: { "content-type": "text/plain", authorization: "Bearer leak", "x-custom": "keep" } })
      },
    })
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async () => "anthro-secret" }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const body = JSON.stringify({ model: "m1" })
        const events: unknown[] = []
        const { promise } = link.clientPeer.requestWithId(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: record(endpoint, "anthropic/messages", ref), body }, (ev) => events.push(ev))
        const res = (await promise) as { seq: number }
        expect(seen.path).toBe("/messages")
        expect(seen.apiKey).toBe("anthro-secret")
        expect(seen.auth).toBeNull()
        const meta = events[0] as { headers: Record<string, string> }
        expect(meta.headers.authorization).toBeUndefined()
        expect(meta.headers["x-custom"]).toBe("keep")
        expect(res.seq).toBe(1)
      } finally {
        disposeLink(link)
      }
    } finally {
      server.stop()
    }
  })

  test("concurrent httpExecute does not cross-deliver", async () => {
    const payloads = new Map<string, string>([
      ["req1", "payload one"],
      ["req2", "payload two"],
    ])
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const body = await req.text()
        const parsed = JSON.parse(body) as { model: string }
        const key = parsed.model === "m1" ? "req1" : "req2"
        // but both use same model, differentiate via header?
        const hdr = req.headers.get("x-custom") ?? ""
        const payload = payloads.get(hdr) ?? "unknown"
        return new Response(payload, { status: 200 })
      },
    })
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async () => "sk" }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const body = JSON.stringify({ model: "m1" })
        const rec = record(endpoint, "openai/completions", ref)
        const evs1: unknown[] = []
        const evs2: unknown[] = []
        const h1 = link.clientPeer.requestWithId(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: rec, body, headers: { "x-custom": "req1" } }, (ev) => evs1.push(ev))
        const h2 = link.clientPeer.requestWithId(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: rec, body, headers: { "x-custom": "req2" } }, (ev) => evs2.push(ev))
        const [r1, r2] = (await Promise.all([h1.promise, h2.promise])) as unknown as Array<{ bytes: number }>
        expect(r1.bytes).toBe(Buffer.from("payload one").length)
        expect(r2.bytes).toBe(Buffer.from("payload two").length)
        const out1 = Buffer.concat(evs1.slice(1).map((e) => Buffer.from((e as { bytes: string }).bytes, "base64"))).toString("utf8")
        const out2 = Buffer.concat(evs2.slice(1).map((e) => Buffer.from((e as { bytes: string }).bytes, "base64"))).toString("utf8")
        expect(out1).toBe("payload one")
        expect(out2).toBe("payload two")
        expect(h1.id).not.toBe(h2.id)
      } finally {
        disposeLink(link)
      }
    } finally {
      server.stop()
    }
  })
})

describe("provider/httpExecute host additional coverage", () => {
  test("3xx redirect is not followed and redirect target receives neither request nor secret", async () => {
    let primaryHit = 0
    let redirectHit = 0
    let redirectAuth: string | null = null
    const redirectServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        redirectHit++
        redirectAuth = req.headers.get("authorization") ?? req.headers.get("x-api-key")
        return new Response("redirected", { status: 200 })
      },
    })
    const primaryServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (_req) => {
        primaryHit++
        return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${redirectServer.port}/redirected` } })
      },
    })
    try {
      const endpoint = `http://127.0.0.1:${primaryServer.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const secret = "sk-redirect-secret-123"
      const deps = { resolveSecret: async (r: string) => (r === ref ? secret : undefined) }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const body = JSON.stringify({ model: "m1" })
        let code: number | undefined
        let errData: unknown
        let msg = ""
        try {
          await link.clientPeer.request(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), body })
        } catch (e) {
          code = (e as { code?: number }).code
          errData = (e as { data?: unknown }).data
          msg = (e as { message?: string }).message ?? ""
        }
        // Should fail closed with InternalError, not follow redirect
        expect(code).toBe(ErrorCode.InternalError)
        // data is whole JSON-RPC error, inner code at data.data.code
        const inner = (errData as { data?: { code?: string }; code?: string })?.data?.code ?? (errData as { code?: string })?.code
        expect(inner).toBe("provider")
        expect(msg.toLowerCase().includes("redirect")).toBeTrue()
        expect(primaryHit).toBe(1)
        expect(redirectHit).toBe(0)
        expect(redirectAuth).toBeNull()
      } finally {
        disposeLink(link)
      }
    } finally {
      primaryServer.stop()
      redirectServer.stop()
    }
  })

  test("endpoint base path/trailing slash produces /v1/<fixed route>", async () => {
    const cases: Array<{ endpointSuffix: string; expectedPath: string; protocol: "openai/completions" | "anthropic/messages" }> = [
      { endpointSuffix: "", expectedPath: "/chat/completions", protocol: "openai/completions" },
      { endpointSuffix: "/", expectedPath: "/chat/completions", protocol: "openai/completions" },
      { endpointSuffix: "/v1", expectedPath: "/v1/chat/completions", protocol: "openai/completions" },
      { endpointSuffix: "/v1/", expectedPath: "/v1/chat/completions", protocol: "openai/completions" },
      { endpointSuffix: "/v1//", expectedPath: "/v1/chat/completions", protocol: "openai/completions" },
      { endpointSuffix: "/api/v1", expectedPath: "/api/v1/chat/completions", protocol: "openai/completions" },
      { endpointSuffix: "/api/v1/", expectedPath: "/api/v1/chat/completions", protocol: "openai/completions" },
      { endpointSuffix: "/v1", expectedPath: "/v1/messages", protocol: "anthropic/messages" },
    ]
    for (const c of cases) {
      let seenPath = ""
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (req) => {
          seenPath = new URL(req.url).pathname
          return new Response("ok", { status: 200 })
        },
      })
      try {
        const endpoint = `http://127.0.0.1:${server.port}${c.endpointSuffix}`
        const ref = "secret:kilo.credentials.global.provider.acme"
        const deps = { resolveSecret: async () => "sk" }
        const link = linkedPair(deps)
        try {
          expect(await link.hostPeer.initialize(500)).toBeTrue()
          const body = JSON.stringify({ model: "m1" })
          const events: unknown[] = []
          const { promise } = link.clientPeer.requestWithId(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: record(endpoint, c.protocol, ref), body }, (ev) => events.push(ev))
          await promise
          expect(seenPath).toBe(c.expectedPath)
        } finally {
          disposeLink(link)
        }
      } finally {
        server.stop()
      }
    }
  })

  test("endpoint userinfo/query/hash rejected before network", async () => {
    const badEndpoints = [
      `http://user:pass@127.0.0.1:9/v1`,
      `http://127.0.0.1:9/v1?query=1`,
      `http://127.0.0.1:9/v1#hash`,
      `http://127.0.0.1:9/v1?query=1#hash`,
      `https://user@127.0.0.1:9/v1`,
    ]
    for (const endpoint of badEndpoints) {
      let hit = false
      // Use a server that would be hit if fetch were attempted, but endpoint is invalid so fetch should not happen
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async () => {
          hit = true
          return new Response("ok")
        },
      })
      try {
        // endpoint is bad, but we still need a valid ref
        const ref = "secret:kilo.credentials.global.provider.acme"
        const deps = { resolveSecret: async () => "sk" }
        const link = linkedPair(deps)
        try {
          expect(await link.hostPeer.initialize(500)).toBeTrue()
          const body = JSON.stringify({ model: "m1" })
          let code: number | undefined
          try {
            await link.clientPeer.request(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), body })
          } catch (e) {
            code = (e as { code?: number }).code
          }
          expect(code).toBe(ErrorCode.InvalidParams)
          expect(hit).toBeFalse()
        } finally {
          disposeLink(link)
        }
      } finally {
        server.stop()
      }
    }
  })

  test("literal and percent-encoded secret split across chunks plus multibyte UTF-8 split reconstruct to [REDACTED] no secret", async () => {
    const secret = "mySecret123"
    const encoded = encodeURIComponent(secret)
    // Payload contains both literal and encoded forms; we will split them across chunks
    const literalPayload = `{"data":"prefix ${secret} suffix"}`
    const encodedPayload = `{"data":"prefix ${encoded} suffix"}`
    // Also test SSE-like payload
    const ssePayload = `data: ${secret}\n\n`
    // Also test multibyte: payload with emoji surrounding secret, but secret itself is ASCII so header remains valid
    const combined = literalPayload + "\n" + encodedPayload + "\n" + ssePayload + "\n" + `{"emoji":"🔑${secret}🔑"}`

    // Helper to create chunked stream that splits at arbitrary byte offsets including inside secret and inside emoji bytes
    function chunkedResponse(text: string, splits: number[]): Response {
      const bytes = new TextEncoder().encode(text)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let offset = 0
          for (const split of splits) {
            if (offset >= bytes.length) break
            const end = Math.min(offset + split, bytes.length)
            controller.enqueue(bytes.subarray(offset, end))
            offset = end
          }
          if (offset < bytes.length) controller.enqueue(bytes.subarray(offset))
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } })
    }

    // Create splits that cut inside secret literal, inside encoded, and inside emoji's 4-byte sequence
    // secret "mySecret🔑123": "mySecret" (8) + "🔑" (4 bytes) + "123" (3) => total 12 chars but 15 bytes
    // We'll split to force carry handling
    const splits = [5, 3, 2, 4, 1, 7, 10, 3, 6]

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => chunkedResponse(combined, splits),
    })
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async (r: string) => (r === ref ? secret : undefined) }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const body = JSON.stringify({ model: "m1" })
        const events: unknown[] = []
        const { promise } = link.clientPeer.requestWithId(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), body }, (ev) => events.push(ev))
        const result = (await promise) as { seq: number; chunks: number; bytes: number }
        const out = Buffer.concat(events.slice(1).map((e) => Buffer.from((e as { bytes: string }).bytes, "base64"))).toString("utf8")
        // Must be valid JSON lines with redacted, no secret
        expect(out.includes(secret)).toBeFalse()
        expect(out.includes(encoded)).toBeFalse()
        expect(out.includes("[REDACTED]")).toBeTrue()
        // Check that redacted output is still valid JSON for first line
        const firstLine = out.split("\n")[0]!
        const parsed = JSON.parse(firstLine) as { data: string }
        expect(parsed.data).toBe("prefix [REDACTED] suffix")
        // terminal counts must match redacted bytes
        expect(result.bytes).toBe(Buffer.byteLength(out, "utf8"))
        expect(result.chunks).toBe(events.length - 1)
        expect(result.seq).toBe(events.length - 1)
      } finally {
        disposeLink(link)
      }
    } finally {
      server.stop()
    }

    // Additional sub-test: percent-encoded split where "%" boundaries are split
    const server2 = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        // Send encoded secret split as "%" + "F0" + "%9F" ... across chunks
        const text = `start ${encoded} end`
        const bytes = new TextEncoder().encode(text)
        // Force splits at every 2 bytes to break % encoding
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.subarray(i, Math.min(i + 2, bytes.length)))
            controller.close()
          },
        })
        return new Response(stream, { status: 200 })
      },
    })
    try {
      const endpoint = `http://127.0.0.1:${server2.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async () => secret }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const body = JSON.stringify({ model: "m1" })
        const events: unknown[] = []
        const { promise } = link.clientPeer.requestWithId(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), body }, (ev) => events.push(ev))
        await promise
        const out = Buffer.concat(events.slice(1).map((e) => Buffer.from((e as { bytes: string }).bytes, "base64"))).toString("utf8")
        expect(out.includes(secret)).toBeFalse()
        expect(out.includes(encoded)).toBeFalse()
        expect(out).toBe("start [REDACTED] end")
      } finally {
        disposeLink(link)
      }
    } finally {
      server2.stop()
    }

    // Multibyte UTF-8 split: send raw bytes where surrounding emoji bytes are split across chunks at byte level, secret remains ASCII
    const server3 = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        const text = `before 🔑 ${secret} 🔑 after`
        const all = new TextEncoder().encode(text)
        // Split inside the leading emoji's 4-byte sequence
        const prefixLen = new TextEncoder().encode("before ").length
        // Emoji "🔑" is 4 bytes, we split after 1 byte, then 1 byte, etc., while secret itself is ASCII
        const splits = [prefixLen + 1, 1, 1, 2, all.length]
        let off = 0
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const sz of splits) {
              if (off >= all.length) break
              const end = Math.min(off + sz, all.length)
              controller.enqueue(all.subarray(off, end))
              off = end
            }
            if (off < all.length) controller.enqueue(all.subarray(off))
            controller.close()
          },
        })
        return new Response(stream, { status: 200 })
      },
    })
    try {
      const endpoint = `http://127.0.0.1:${server3.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async () => secret }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const body = JSON.stringify({ model: "m1" })
        const events: unknown[] = []
        const { promise } = link.clientPeer.requestWithId(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), body }, (ev) => events.push(ev))
        await promise
        const out = Buffer.concat(events.slice(1).map((e) => Buffer.from((e as { bytes: string }).bytes, "base64"))).toString("utf8")
        expect(out).toBe("before 🔑 [REDACTED] 🔑 after")
        expect(out.includes(secret)).toBeFalse()
      } finally {
        disposeLink(link)
      }
    } finally {
      server3.stop()
    }
  })

  test("response header arbitrary value containing secret is redacted", async () => {
    const secret = "headerSecret123"
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => new Response("ok", { status: 200, headers: { "x-echo": `value-${secret}-end`, "x-custom": "keep", "content-type": "text/plain" } }),
    })
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async (r: string) => (r === ref ? secret : undefined) }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const body = JSON.stringify({ model: "m1" })
        const events: unknown[] = []
        const { promise } = link.clientPeer.requestWithId(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), body }, (ev) => events.push(ev))
        await promise
        const meta = events[0] as { headers: Record<string, string> }
        expect(meta.headers["x-echo"]).toBe("value-[REDACTED]-end")
        expect(meta.headers["x-echo"]!.includes(secret)).toBeFalse()
        expect(meta.headers["x-custom"]).toBe("keep")
      } finally {
        disposeLink(link)
      }
    } finally {
      server.stop()
    }
    // also test percent-encoded in header
    const encoded = encodeURIComponent(secret)
    const server2 = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => new Response("ok", { status: 200, headers: { "x-echo": `val ${encoded} tail` } }),
    })
    try {
      const endpoint = `http://127.0.0.1:${server2.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async () => secret }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const body = JSON.stringify({ model: "m1" })
        const events: unknown[] = []
        const { promise } = link.clientPeer.requestWithId(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), body }, (ev) => events.push(ev))
        await promise
        const meta = events[0] as { headers: Record<string, string> }
        expect(meta.headers["x-echo"]!.includes(secret)).toBeFalse()
        expect(meta.headers["x-echo"]!.includes(encoded)).toBeFalse()
        expect(meta.headers["x-echo"]).toBe("val [REDACTED] tail")
      } finally {
        disposeLink(link)
      }
    } finally {
      server2.stop()
    }
  })

  test("terminal seq/chunks/bytes equal exact emitted redacted bytes", async () => {
    const secret = "termSecret"
    const payload = `before ${secret} after and more ${secret} end`
    const expectedRedacted = `before [REDACTED] after and more [REDACTED] end`
    const expectedBytes = Buffer.byteLength(expectedRedacted, "utf8")
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => new Response(payload, { status: 200 }),
    })
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async () => secret }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const body = JSON.stringify({ model: "m1" })
        const events: unknown[] = []
        const { promise } = link.clientPeer.requestWithId(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), body }, (ev) => events.push(ev))
        const result = (await promise) as { seq: number; chunks: number; bytes: number }
        const out = Buffer.concat(events.slice(1).map((e) => Buffer.from((e as { bytes: string }).bytes, "base64"))).toString("utf8")
        expect(out).toBe(expectedRedacted)
        expect(out.includes(secret)).toBeFalse()
        // terminal must equal redacted bytes, not original
        expect(result.bytes).toBe(expectedBytes)
        expect(result.bytes).toBe(Buffer.byteLength(out, "utf8"))
        expect(result.chunks).toBe(events.length - 1)
        expect(result.seq).toBe(events.length - 1)
        // each chunk seq ordered
        for (let i = 1; i < events.length; i++) expect((events[i] as { seq: number }).seq).toBe(i)
      } finally {
        disposeLink(link)
      }
    } finally {
      server.stop()
    }
  })

  test("cancellation/resources still cleaned after redacted streaming", async () => {
    let aborted = false
    const secret = "cancelSecret"
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        req.signal.addEventListener("abort", () => (aborted = true), { once: true })
        await new Promise((r) => setTimeout(r, 500))
        if (req.signal.aborted) aborted = true
        return new Response(`data ${secret} end`, { status: 200 })
      },
    })
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async () => secret }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const body = JSON.stringify({ model: "m1" })
        const { id, promise } = link.clientPeer.requestWithId(PROVIDER_HTTP_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), body })
        setTimeout(() => link.clientPeer.cancel(id), 50)
        let threw = false
        try {
          await promise
        } catch {
          threw = true
        }
        expect(threw).toBeTrue()
        await new Promise((r) => setTimeout(r, 200))
        expect(aborted).toBeTrue()
        const peer = (link.hostPeer as unknown as { peer: JsonRpcPeer | null }).peer
        expect(peer?.getIncomingCount()).toBe(0)
        expect(link.clientPeer.getPendingCount()).toBe(0)
      } finally {
        disposeLink(link)
      }
    } finally {
      server.stop()
    }
  })
})
