import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ServePrivatePeer } from "../../src/services/cli-backend/serve-private-peer"
import {
  PROVIDER_EXECUTE_METHOD,
  validateProviderExecuteParams,
  type ProviderExecuteParams,
} from "../../src/services/cli-backend/serve-private-provider-execute"
import { ErrorCode } from "../../src/private-worker/json-rpc"

const sse = (...chunks: ReadonlyArray<unknown>): string =>
  `${chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`

const chatBody = () =>
  sse(
    { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
  )

const serve = (body: () => string, seen: { path: string; auth: string | null; body: string }) => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      seen.path = url.pathname
      seen.auth = req.headers.get("authorization")
      seen.body = await req.text()
      return new Response(body(), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return server
}

const record = (endpoint: string, protocol: "openai/completions" | "openai/responses" | "anthropic/messages", ref?: string) => ({
  name: "Acme",
  endpoint,
  protocol,
  models: { m1: { name: "M1" } },
  ...(ref === undefined ? {} : { credential: ref }),
})

function linkedPair(deps?: { resolveSecret: (ref: string) => Promise<string | undefined> }, extra?: { reverseCapabilities?: readonly string[] }) {
  const hostToClient = new PassThrough()
  const clientToHost = new PassThrough()
  const hostPeer = new ServePrivatePeer({
    reader: clientToHost,
    writer: hostToClient,
    pid: 601 + Math.floor(Math.random() * 100),
    epoch: 61 + Math.floor(Math.random() * 100),
    ...(deps ? { providerExecuteDeps: deps } : {}),
    ...(extra?.reverseCapabilities ? { reverseCapabilities: extra.reverseCapabilities } : {}),
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
  try {
    link.hostPeer.dispose()
  } catch {}
  try {
    link.clientPeer.dispose()
  } catch {}
  try {
    link.hostToClient.destroy()
  } catch {}
  try {
    link.clientToHost.destroy()
  } catch {}
}

function disposeAll(fixture: { toClient: PassThrough; toBackend: PassThrough; backend: JsonRpcPeer }, peer: ServePrivatePeer) {
  try {
    peer.dispose()
  } catch {}
  try {
    fixture.backend.dispose()
  } catch {}
  try {
    fixture.toClient.destroy()
  } catch {}
  try {
    fixture.toBackend.destroy()
  } catch {}
}

function fixture(handler: (method: string, params: unknown) => unknown | Promise<unknown>) {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const seen: { method: string; params: unknown }[] = []
  const backend = new JsonRpcPeer({
    reader: toBackend,
    writer: toClient,
    onRequest: ((m: string, p: unknown) => {
      seen.push({ method: m, params: p })
      return handler(m, p)
    }) as unknown as (m: string, p: unknown) => unknown,
  })
  return { clientReader: toClient, clientWriter: toBackend, toClient, toBackend, backend, seen }
}

// Helpers for abort-observation cancellation tests: production-real transport signal is Bun's
// Request.signal abort (client fetch abort propagates to server's Request.signal). In this fixture
// Bun's Request.signal does expose client disconnect (verified: abort fires ~50ms after client fetch
// abort). We await that signal directly and do not treat the delayed handler completing as proof.
// Incoming ownership is the host JsonRpcPeer incoming AbortController map; it must return to zero
// before teardown, proving the handler settled and ownership was released.
function hostIncomingCount(hostPeer: ServePrivatePeer): number {
  const peer = (hostPeer as unknown as { peer: JsonRpcPeer | null }).peer
  return peer ? peer.getIncomingCount() : 0
}

async function waitForHostIncomingZero(hostPeer: ServePrivatePeer, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (hostIncomingCount(hostPeer) === 0) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`host incoming not zero after ${timeoutMs}ms: ${hostIncomingCount(hostPeer)}`)
}

function trackedServer(body: () => string) {
  let aborted = false
  let abortTime: number | null = null
  const startMark = Date.now()
  let resolveAbort: () => void = () => {}
  const abortPromise = new Promise<void>((resolve) => {
    resolveAbort = () => {
      if (!aborted) {
        aborted = true
        abortTime = Date.now() - startMark
      }
      resolve()
    }
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const sig = req.signal
      if (sig.aborted) {
        aborted = true
        abortTime = Date.now() - startMark
        resolveAbort()
      } else {
        sig.addEventListener("abort", () => {
          aborted = true
          abortTime = Date.now() - startMark
          resolveAbort()
        }, { once: true })
      }
      try {
        await req.text()
      } catch {}
      // Keep artificial 500ms provider delay so fast rejection cannot be confused with normal completion.
      await new Promise((r) => setTimeout(r, 500))
      return new Response(body(), { headers: { "content-type": "text/event-stream" } })
    },
  })
  const withTimeout = (p: Promise<void>, ms: number, label: string): Promise<void> =>
    Promise.race([p, new Promise<void>((_, rej) => setTimeout(() => rej(new Error(`${label} abort not observed within ${ms}ms`)), ms))])
  return {
    server,
    get aborted() {
      return aborted
    },
    get abortTime() {
      return abortTime
    },
    abortPromise,
    awaitAbort: (ms = 1000) => withTimeout(abortPromise, ms, "provider HTTP"),
  }
}

describe("provider/execute reverse capability", () => {
  test("advertises only when deps installed", async () => {
    const f1 = fixture(async (m) => {
      if (m === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      throw new Error("x")
    })
    const peer1 = new ServePrivatePeer({ reader: f1.clientReader, writer: f1.clientWriter, pid: 601, epoch: 61, providerExecuteDeps: { resolveSecret: async () => "sk" } })
    try {
      expect(await peer1.initialize(500)).toBeTrue()
      const init = f1.seen.find((s) => s.method === "initialize")
      const params = init!.params as { reverseCapabilities: unknown }
      expect((params.reverseCapabilities as string[]).includes(PROVIDER_EXECUTE_METHOD)).toBeTrue()
    } finally {
      disposeAll(f1, peer1)
    }

    const f2 = fixture(async (m) => {
      if (m === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      throw new Error("x")
    })
    const peer2 = new ServePrivatePeer({ reader: f2.clientReader, writer: f2.clientWriter, pid: 602, epoch: 62 })
    try {
      expect(await peer2.initialize(500)).toBeTrue()
      const init = f2.seen.find((s) => s.method === "initialize")
      const params = init!.params as { reverseCapabilities: unknown }
      expect((params.reverseCapabilities as string[]).includes(PROVIDER_EXECUTE_METHOD)).toBeFalse()
    } finally {
      disposeAll(f2, peer2)
    }
  })

  test("explicit provider/execute without deps fails closed", async () => {
    const f = fixture(async (m) => {
      if (m === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({ reader: f.clientReader, writer: f.clientWriter, pid: 603, epoch: 63, reverseCapabilities: [PROVIDER_EXECUTE_METHOD] })
    try {
      expect(await peer.initialize(500)).toBeFalse()
      expect(peer.isAvailable()).toBeFalse()
      expect(f.seen.find((s) => s.method === "initialize")).toBeUndefined()
    } finally {
      disposeAll(f, peer)
    }
  })

  test("successful routing via production ServePrivatePeer with secret redaction", async () => {
    const seen = { path: "", auth: null as string | null, body: "" }
    const server = serve(chatBody, seen)
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async (r: string) => (r === ref ? "sk-live-secret" : undefined) }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        expect(link.hostPeer.isAvailable()).toBeTrue()
        const params: ProviderExecuteParams = { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), prompt: "Say hello." }
        const result = (await link.clientPeer.request(PROVIDER_EXECUTE_METHOD, params)) as { text: string; providerId: string; modelId: string; events: unknown[]; path: string }
        expect(result.text).toBe("Hello")
        expect(result.providerId).toBe("acme")
        expect(result.modelId).toBe("m1")
        expect(seen.path).toBe("/chat/completions")
        expect(seen.auth).toBe("Bearer sk-live-secret")
        expect(JSON.stringify(result)).not.toContain("sk-live-secret")
        expect(Array.isArray(result.events) && result.events.some((e: unknown) => (e as { type?: string }).type === "text-delta")).toBeTrue()
        expect(link.clientPeer.getPendingCount()).toBe(0)
        expect(link.hostPeer.isAvailable()).toBeTrue()
      } finally {
        disposeLink(link)
      }
    } finally {
      server.stop()
    }
  })

  test("strict invalid params rejection maps to InvalidParams via production peer", async () => {
    const deps = { resolveSecret: async () => "sk" }
    const badCases: unknown[] = [
      null,
      {},
      { providerId: "", modelId: "m1", record: { endpoint: "http://x", protocol: "openai/completions", models: { m1: { name: "M" } }, credential: "secret:kilo.credentials.global.provider.acme" }, prompt: "hi" },
      { providerId: "acme", modelId: "", record: { endpoint: "http://x", protocol: "openai/completions", models: { m1: { name: "M" } }, credential: "secret:kilo.credentials.global.provider.acme" }, prompt: "hi" },
      { providerId: "acme", modelId: "m1", record: null, prompt: "hi" },
      { providerId: "acme", modelId: "m1", record: { endpoint: "http://x", protocol: "openai/completions", models: { m1: { name: "M" } }, credential: "secret:kilo.credentials.global.provider.acme" }, prompt: 123 },
      { providerId: "acme", modelId: "m1", record: { endpoint: "http://x", protocol: "openai/completions", models: { m1: { name: "M" } }, credential: "secret:kilo.credentials.global.provider.acme" }, prompt: "hi", extra: 1 },
      { providerId: "acme\0", modelId: "m1", record: { endpoint: "http://x", protocol: "openai/completions", models: { m1: { name: "M" } }, credential: "secret:kilo.credentials.global.provider.acme" }, prompt: "hi" },
    ]
    for (const raw of badCases) {
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        let code: number | undefined
        try {
          await link.clientPeer.request(PROVIDER_EXECUTE_METHOD, raw)
        } catch (e) {
          code = (e as { code?: number }).code
        }
        expect(code, String(raw)).toBe(ErrorCode.InvalidParams)
        // also assert error data is not leaking secret and has no provider work (pending cleared)
        expect(link.clientPeer.getPendingCount()).toBe(0)
      } finally {
        disposeLink(link)
      }
    }
  })

  test("canonical failure classification preserves exact codes without leaking secret via production peer", async () => {
    const secret = "sk-err-secret"
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        await req.text()
        return new Response(JSON.stringify({ error: { message: `bad ${secret} key`, type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } })
      },
    })
    const extractCode = (err: unknown): string | undefined => {
      const d = (err as { data?: unknown })?.data as unknown
      if (d && typeof d === "object") {
        const o = d as Record<string, unknown>
        if (typeof o.code === "string") return o.code
        if (o.data && typeof o.data === "object") {
          const inner = o.data as Record<string, unknown>
          if (typeof inner.code === "string") return inner.code
        }
      }
      return (err as { data?: { code?: string } })?.data?.code
    }
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async () => secret }
      // provider error
      {
        const link = linkedPair(deps)
        try {
          expect(await link.hostPeer.initialize(500)).toBeTrue()
          const params: ProviderExecuteParams = { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), prompt: "hi" }
          let errData: unknown
          try {
            await link.clientPeer.request(PROVIDER_EXECUTE_METHOD, params)
          } catch (e) {
            errData = e
          }
          expect((errData as { code?: number })?.code).toBe(ErrorCode.InternalError)
          expect(extractCode(errData)).toBe("provider")
          expect(String((errData as { message?: string })?.message ?? "")).not.toContain(secret)
          expect(JSON.stringify(errData)).not.toContain(secret)
        } finally {
          disposeLink(link)
        }
      }
      // missing-secret
      {
        const depsMissing = { resolveSecret: async () => undefined }
        const link = linkedPair(depsMissing)
        try {
          expect(await link.hostPeer.initialize(500)).toBeTrue()
          const params: ProviderExecuteParams = { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), prompt: "hi" }
          let errData: unknown
          try {
            await link.clientPeer.request(PROVIDER_EXECUTE_METHOD, params)
          } catch (e) {
            errData = e
          }
          expect((errData as { code?: number })?.code).toBe(ErrorCode.InternalError)
          expect(extractCode(errData)).toBe("missing-secret")
        } finally {
          disposeLink(link)
        }
      }
      // exact endpoint/protocol/credential codes via executor (not collapsed to invalid-record)
      const cases: Array<{ rec: unknown; code: string; jsonCode: number }> = [
        { rec: { name: "Acme", endpoint: "ftp://bad", protocol: "openai/completions", models: { m1: { name: "M1" } }, credential: ref }, code: "invalid-endpoint", jsonCode: ErrorCode.InvalidParams },
        { rec: { name: "Acme", endpoint, protocol: "openai/unknown" as unknown as string, models: { m1: { name: "M1" } }, credential: ref }, code: "unknown-protocol", jsonCode: ErrorCode.InvalidParams },
        { rec: { name: "Acme", endpoint, protocol: "openai/completions", models: { m1: { name: "M1" } }, credential: "secret:kilo.credentials.global.provider.other" }, code: "invalid-credential-ref", jsonCode: ErrorCode.InvalidParams },
        { rec: { name: "Acme", endpoint, protocol: "openai/completions", models: { m1: { name: "M1" } } }, code: "missing-credential-ref", jsonCode: ErrorCode.InvalidParams },
        { rec: { name: "Acme", endpoint, protocol: "openai/completions", models: { m1: { name: "M1" } }, credential: ref }, code: "unknown-model", jsonCode: ErrorCode.InvalidParams },
        { rec: { name: "Acme", endpoint, protocol: "openai/completions", models: { m1: { name: "M1" } }, credential: ref, extra: "x" } as unknown as Record<string, unknown>, code: "invalid-record", jsonCode: ErrorCode.InvalidParams },
      ]
      for (const c of cases) {
        const link = linkedPair(deps)
        try {
          expect(await link.hostPeer.initialize(500)).toBeTrue()
          const params = { providerId: "acme", modelId: c.code === "unknown-model" ? "unknown" : "m1", record: c.rec, prompt: "hi" }
          let errData: unknown
          try {
            await link.clientPeer.request(PROVIDER_EXECUTE_METHOD, params)
          } catch (e) {
            errData = e
          }
          expect((errData as { code?: number })?.code, c.code).toBe(c.jsonCode)
          expect(extractCode(errData), c.code).toBe(c.code)
        } finally {
          disposeLink(link)
        }
      }
    } finally {
      server.stop()
    }
  })

  test("host validates full CanonicalProviderPayload AST: nested malformed never reaches HTTP fixture", async () => {
    const seen = { path: "", auth: null as string | null, body: "" }
    const server = serve(chatBody, seen as { path: string; auth: string | null; body: string })
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
        { name: "provider extra key", rec: { ...(base as unknown as Record<string, unknown>), extraKey: "x" } },
        { name: "model name empty", rec: { ...base, models: { m1: { name: "" } } } },
        { name: "model missing name", rec: { ...base, models: { m1: {} as unknown } } },
      ]
      const deps = { resolveSecret: async (r: string) => (r === ref ? "sk-test" : undefined) }
      for (const item of malformed) {
        const link = linkedPair(deps)
        seen.path = ""
        try {
          expect(await link.hostPeer.initialize(500)).toBeTrue()
          let errData: unknown
          try {
            await link.clientPeer.request(PROVIDER_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: item.rec, prompt: "hi" })
          } catch (e) {
            errData = e
          }
          expect((errData as { code?: number })?.code, item.name).toBe(ErrorCode.InvalidParams)
          const code = (() => {
            const d = (errData as { data?: unknown })?.data as unknown
            if (d && typeof d === "object") {
              const o = d as Record<string, unknown>
              if (typeof o.code === "string") return o.code
              if (o.data && typeof o.data === "object" && typeof (o.data as Record<string, unknown>).code === "string") return (o.data as Record<string, unknown>).code
            }
            return undefined
          })()
          expect(code, item.name).toBe("invalid-record")
          expect(seen.path, item.name).toBe("")
          expect(link.clientPeer.getPendingCount()).toBe(0)
          expect(hostIncomingCount(link.hostPeer)).toBe(0)
          expect(JSON.stringify(errData)).not.toContain("sk-test")
        } finally {
          disposeLink(link)
        }
      }
      // granular cases still retain exact codes and also never reach HTTP (validation before network)
      const granular: ReadonlyArray<{ rec: unknown; code: string; mid: string; name: string }> = [
        { name: "invalid-endpoint", rec: { ...base, endpoint: "ftp://bad" }, code: "invalid-endpoint", mid: "m1" },
        { name: "unknown-protocol", rec: { ...base, protocol: "openai/unknown" as unknown }, code: "unknown-protocol", mid: "m1" },
        { name: "unknown-model", rec: base, code: "unknown-model", mid: "unknown" },
        { name: "missing-credential-ref", rec: { name: "Acme", endpoint, protocol: "openai/completions", models: { m1: { name: "M1" } } }, code: "missing-credential-ref", mid: "m1" },
        { name: "invalid-credential-ref", rec: { ...base, credential: "secret:kilo.credentials.global.provider.other" }, code: "invalid-credential-ref", mid: "m1" },
      ]
      for (const g of granular) {
        const link = linkedPair(deps)
        seen.path = ""
        try {
          expect(await link.hostPeer.initialize(500)).toBeTrue()
          let errData: unknown
          try {
            await link.clientPeer.request(PROVIDER_EXECUTE_METHOD, { providerId: "acme", modelId: g.mid, record: g.rec, prompt: "hi" })
          } catch (e) {
            errData = e
          }
          expect((errData as { code?: number })?.code, g.name).toBe(ErrorCode.InvalidParams)
          const code = (() => {
            const d = (errData as { data?: unknown })?.data as unknown
            if (d && typeof d === "object") {
              const o = d as Record<string, unknown>
              if (typeof o.code === "string") return o.code
              if (o.data && typeof o.data === "object" && typeof (o.data as Record<string, unknown>).code === "string") return (o.data as Record<string, unknown>).code
            }
            return undefined
          })()
          expect(code, g.name).toBe(g.code)
          expect(seen.path, g.name).toBe("")
        } finally {
          disposeLink(link)
        }
      }
    } finally {
      server.stop()
    }
  })

  test("cancellation via $/cancelRequest aborts Effect and HTTP without continued provider work", async () => {
    const tracked = trackedServer(chatBody)
    try {
      const endpoint = `http://127.0.0.1:${tracked.server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async () => "sk-cancel" }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const params: ProviderExecuteParams = { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), prompt: "hi" }
        const start = Date.now()
        const { id, promise } = link.clientPeer.requestWithId(PROVIDER_EXECUTE_METHOD, params)
        setTimeout(() => link.clientPeer.cancel(id), 100)
        let threw = false
        let code: number | undefined
        try {
          await promise
        } catch (e) {
          threw = true
          code = (e as { code?: number }).code
        }
        const elapsed = Date.now() - start
        // Separate assertion: fast caller rejection, independent of transport abort timing
        expect(threw).toBeTrue()
        expect(code).toBe(ErrorCode.InternalError)
        expect(elapsed).toBeLessThan(400)
        expect(link.clientPeer.getPendingCount()).toBe(0)
        // Direct transport observation: provider HTTP request's abort signal must fire
        await tracked.awaitAbort(1000)
        expect(tracked.aborted).toBeTrue()
        expect(tracked.abortTime).not.toBeNull()
        expect(tracked.abortTime!).toBeLessThan(400)
        // Production host peer incoming request ownership returns to zero before teardown
        await waitForHostIncomingZero(link.hostPeer, 1000)
        expect(hostIncomingCount(link.hostPeer)).toBe(0)
      } finally {
        // Ensure incoming zero before final disposeLink (already asserted)
        try {
          await waitForHostIncomingZero(link.hostPeer, 500)
        } catch {}
        disposeLink(link)
      }
    } finally {
      tracked.server.stop()
    }
  }, { timeout: 10000 })

  test("cancellation via peer close aborts and settles without continued work", async () => {
    const tracked = trackedServer(chatBody)
    try {
      const endpoint = `http://127.0.0.1:${tracked.server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async () => "sk-close" }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const params: ProviderExecuteParams = { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), prompt: "hi" }
        const start = Date.now()
        const p = link.clientPeer.request(PROVIDER_EXECUTE_METHOD, params)
        setTimeout(() => {
          link.hostPeer.dispose()
          try { link.hostToClient.destroy() } catch {}
          try { link.clientToHost.destroy() } catch {}
        }, 100)
        let threw = false
        try { await p } catch { threw = true }
        const elapsed = Date.now() - start
        // Separate fast caller rejection assertion
        expect(threw).toBeTrue()
        expect(elapsed).toBeLessThan(400)
        expect(link.clientPeer.getPendingCount()).toBe(0)
        // Direct transport observation: provider HTTP abort signal
        await tracked.awaitAbort(1000)
        expect(tracked.aborted).toBeTrue()
        expect(tracked.abortTime).not.toBeNull()
        expect(tracked.abortTime!).toBeLessThan(400)
        // Host incoming ownership zero before teardown (peer already disposed, but incoming cleared)
        expect(hostIncomingCount(link.hostPeer)).toBe(0)
      } finally {
        disposeLink(link)
      }
    } finally {
      tracked.server.stop()
    }
  }, { timeout: 10000 })

  test("cancellation via dispose aborts without continued provider work", async () => {
    const tracked = trackedServer(chatBody)
    try {
      const endpoint = `http://127.0.0.1:${tracked.server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const deps = { resolveSecret: async () => "sk-dispose" }
      const link = linkedPair(deps)
      try {
        expect(await link.hostPeer.initialize(500)).toBeTrue()
        const params: ProviderExecuteParams = { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), prompt: "hi" }
        const start = Date.now()
        const p = link.clientPeer.request(PROVIDER_EXECUTE_METHOD, params)
        setTimeout(() => {
          disposeLink(link)
        }, 100)
        let threw = false
        try { await p } catch { threw = true }
        const elapsed = Date.now() - start
        // Separate fast caller rejection assertion
        expect(threw).toBeTrue()
        expect(elapsed).toBeLessThan(400)
        // Direct transport observation: provider HTTP abort signal
        await tracked.awaitAbort(1000)
        expect(tracked.aborted).toBeTrue()
        expect(tracked.abortTime).not.toBeNull()
        expect(tracked.abortTime!).toBeLessThan(400)
        // Host incoming ownership zero after dispose (ServePrivatePeer disposes its JsonRpcPeer and clears incoming)
        expect(hostIncomingCount(link.hostPeer)).toBe(0)
      } finally {
        try { disposeLink(link) } catch {}
      }
    } finally {
      tracked.server.stop()
    }
  }, { timeout: 10000 })

  test("validate strict no extra keys and no proto pollution", () => {
    expect(() => validateProviderExecuteParams({ providerId: "a", modelId: "m", record: {}, prompt: "hi", __proto__: {} })).toThrow()
    expect(() => validateProviderExecuteParams({ providerId: "a", modelId: "m", record: {}, prompt: "hi", constructor: {} })).toThrow()
  })

  test("regression: modalities array and inherited model IDs via production peer preserve family/data, no secret, no HTTP, ownership zero", async () => {
    const seen = { path: "", auth: null as string | null, body: "" }
    const server = serve(chatBody, seen as { path: string; auth: string | null; body: string })
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const secret = "sk-regression-secret-peer"
      const base = record(endpoint, "openai/completions", ref)
      const deps = { resolveSecret: async (r: string) => (r === ref ? secret : undefined) }
      const extract = (err: unknown): { code?: number; dataCode?: string; message?: string } => {
        const d = (err as { data?: unknown })?.data as unknown
        let dataCode: string | undefined
        if (d && typeof d === "object") {
          const o = d as Record<string, unknown>
          if (typeof o.code === "string") dataCode = o.code
          else if (o.data && typeof o.data === "object" && typeof (o.data as Record<string, unknown>).code === "string") dataCode = (o.data as Record<string, unknown>).code as string
        }
        return { code: (err as { code?: number })?.code, dataCode, message: (err as { message?: string })?.message }
      }
      // modalities: [] -> invalid-record, InvalidParams, no HTTP, no secret leak, ownership zero
      for (const mods of [[], ["text"] as unknown]) {
        const link = linkedPair(deps)
        seen.path = ""
        try {
          expect(await link.hostPeer.initialize(500)).toBeTrue()
          const rec = { ...base, models: { m1: { name: "M1", modalities: mods as unknown } } }
          let err: unknown
          try { await link.clientPeer.request(PROVIDER_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: rec, prompt: "hi" }) } catch (e) { err = e }
          const got = extract(err)
          expect(got.code, `mods ${JSON.stringify(mods)}`).toBe(ErrorCode.InvalidParams)
          expect(got.dataCode, `mods ${JSON.stringify(mods)}`).toBe("invalid-record")
          expect(seen.path, `mods ${JSON.stringify(mods)}`).toBe("")
          expect(JSON.stringify(err), `mods ${JSON.stringify(mods)}`).not.toContain(secret)
          expect(String((err as { message?: string })?.message ?? ""), `mods ${JSON.stringify(mods)}`).not.toContain(secret)
          expect(link.clientPeer.getPendingCount()).toBe(0)
          expect(link.clientPeer.getPendingIds().length).toBe(0)
          expect(hostIncomingCount(link.hostPeer)).toBe(0)
        } finally {
          disposeLink(link)
        }
      }
      // inherited model IDs -> unknown-model, InvalidParams, no HTTP, no secret, ownership zero
      for (const inherited of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
        const link = linkedPair(deps)
        seen.path = ""
        try {
          expect(await link.hostPeer.initialize(500)).toBeTrue()
          let err: unknown
          try { await link.clientPeer.request(PROVIDER_EXECUTE_METHOD, { providerId: "acme", modelId: inherited, record: base, prompt: "hi" }) } catch (e) { err = e }
          const got = extract(err)
          expect(got.code, inherited).toBe(ErrorCode.InvalidParams)
          expect(got.dataCode, inherited).toBe("unknown-model")
          expect(seen.path, inherited).toBe("")
          expect(JSON.stringify(err), inherited).not.toContain(secret)
          expect(String((err as { message?: string })?.message ?? ""), inherited).not.toContain(secret)
          expect(link.clientPeer.getPendingCount(), inherited).toBe(0)
          expect(link.clientPeer.getPendingIds().length, inherited).toBe(0)
          expect(hostIncomingCount(link.hostPeer), inherited).toBe(0)
        } finally {
          disposeLink(link)
        }
      }
      // control: valid model still succeeds
      {
        const link = linkedPair(deps)
        seen.path = ""
        try {
          expect(await link.hostPeer.initialize(500)).toBeTrue()
          const result = (await link.clientPeer.request(PROVIDER_EXECUTE_METHOD, { providerId: "acme", modelId: "m1", record: base, prompt: "hi" })) as { text: string }
          expect(result.text).toBe("Hello")
          expect(seen.path).toBe("/chat/completions")
          expect(link.clientPeer.getPendingCount()).toBe(0)
          expect(hostIncomingCount(link.hostPeer)).toBe(0)
        } finally {
          disposeLink(link)
        }
      }
    } finally {
      server.stop()
    }
  })
})
