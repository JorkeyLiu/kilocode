import { describe, expect, it } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"

describe("session delete SDK body serialization", () => {
  it("generated client sends durable delete body via fetch", async () => {
    const captured: { url: string; method: string; bodyText: string | null; headers: Record<string, string> }[] = []
    const fakeFetch = async (req: Request): Promise<Response> => {
      const text = req.body ? await (req as Request).text().catch(() => null) : null
      // also try clone
      let bodyText: string | null = null
      try {
        const clone = req.clone()
        bodyText = await clone.text()
        if (bodyText === "") bodyText = null
      } catch {
        bodyText = text
      }
      const h: Record<string, string> = {}
      req.headers.forEach((v, k) => { h[k] = v })
      captured.push({ url: req.url, method: req.method, bodyText, headers: h })
      return new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } })
    }

    const client = createKiloClient({ baseUrl: "http://localhost:4096", fetch: fakeFetch as unknown as typeof fetch })

    const dir = "/tmp/repo"
    const sessionId = "ses_body_test_12345678"
    const opId = `delete:${sessionId}:tok123`
    const requestId = "req-body-test"
    // This is the correct generated shape after fix: query_directory + body_directory + durable fields
    await client.session.delete({
      sessionID: sessionId,
      query_directory: dir,
      body_directory: dir,
      opId,
      idempotencyKey: opId,
      requestId,
      context: { directory: dir, sessionId, parentSessionId: null },
    } as unknown as Parameters<typeof client.session.delete>[0])

    expect(captured).toHaveLength(1)
    const req = captured[0]!
    expect(req.method).toBe("DELETE")
    expect(req.url).toContain(encodeURIComponent(sessionId))
    // query directory must be present as query param
    expect(req.url).toContain("directory=")
    // body must be JSON and contain durable fields
    expect(req.bodyText).not.toBeNull()
    const body = JSON.parse(req.bodyText!)
    expect(body.directory).toBe(dir)
    expect(body.opId).toBe(opId)
    expect(body.idempotencyKey).toBe(opId)
    expect(body.requestId).toBe(requestId)
    expect(body.context.directory).toBe(dir)
    expect(body.context.sessionId).toBe(sessionId)
    expect(req.headers["content-type"]).toContain("application/json")
  })

  it("fallback via deleteSessionPrivateFirst sends body (no server config)", async () => {
    const captured: { method: string; url: string; bodyText: string | null }[] = []
    const fakeFetch = async (req: Request): Promise<Response> => {
      let bodyText: string | null = null
      try {
        const c = req.clone()
        bodyText = await c.text()
        if (bodyText === "") bodyText = null
      } catch {}
      captured.push({ method: req.method, url: req.url, bodyText })
      return new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    const client = createKiloClient({ baseUrl: "http://localhost:4096", fetch: fakeFetch as unknown as typeof fetch })
    const { deleteSessionPrivateFirst } = await import("../../src/kilo-provider/session-delete")
    const conn = {
      isPrivateAvailable: () => false,
      getServerConfig: () => null,
    } as unknown as never
    await deleteSessionPrivateFirst({ client, connection: conn, sessionId: "ses_fallback_body", directory: "/repo/fallback" })
    expect(captured).toHaveLength(1)
    const body = JSON.parse(captured[0]!.bodyText!)
    expect(body.opId.startsWith("delete:ses_fallback_body:")).toBeTrue()
    expect(body.idempotencyKey).toBe(body.opId)
    expect(body.directory).toBe("/repo/fallback")
    expect(body.context.directory).toBe("/repo/fallback")
    expect(body.context.sessionId).toBe("ses_fallback_body")
  })

  it("durable raw fetch accepts only boolean true (strict)", async () => {
    const { deleteSessionPrivateFirst } = await import("../../src/kilo-provider/session-delete")
    const makeClient = (fakeFetch: typeof fetch) => createKiloClient({ baseUrl: "http://localhost:4096", fetch: fakeFetch as unknown as typeof fetch })
    const cases: Array<[string, (req: Request) => Promise<Response>]> = [
      ["false body", async () => new Response(JSON.stringify(false), { status: 200, headers: { "Content-Type": "application/json" } })],
      ["empty body", async () => new Response("", { status: 200, headers: { "Content-Type": "application/json" } })],
      ["malformed json", async () => new Response("{not json", { status: 200, headers: { "Content-Type": "application/json" } })],
      ["object body", async () => new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } })],
      ["string true", async () => new Response(JSON.stringify("true"), { status: 200, headers: { "Content-Type": "application/json" } })],
      ["number 1", async () => new Response(JSON.stringify(1), { status: 200, headers: { "Content-Type": "application/json" } })],
      ["null body", async () => new Response(JSON.stringify(null), { status: 200, headers: { "Content-Type": "application/json" } })],
    ]
    for (const [, responder] of cases) {
      const client = makeClient(responder as unknown as typeof fetch)
      const connFetch = {
        isPrivateAvailable: () => false,
        getServerConfig: () => ({ baseUrl: "http://localhost:4096", password: "p" }),
      } as unknown as never
      const origFetch = globalThis.fetch
      ;(globalThis as unknown as { fetch: typeof fetch }).fetch = responder as unknown as typeof fetch
      try {
        await expect(deleteSessionPrivateFirst({ client, connection: connFetch, sessionId: "ses_fetch_strict", directory: "/repo" })).rejects.toThrow()
      } finally {
        ;(globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch
      }
    }
    // verify true still succeeds for fetch branch
    const trueResponder = async () => new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } })
    const clientOk = makeClient(trueResponder as unknown as typeof fetch)
    const connOk = {
      isPrivateAvailable: () => false,
      getServerConfig: () => ({ baseUrl: "http://localhost:4096", password: "p" }),
    } as unknown as never
    const origFetch2 = globalThis.fetch
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = trueResponder as unknown as typeof fetch
    try {
      await deleteSessionPrivateFirst({ client: clientOk, connection: connOk, sessionId: "ses_fetch_ok", directory: "/repo" })
    } finally {
      ;(globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch2
    }
  })

  it("generated SDK fallback accepts only boolean true (strict)", async () => {
    const { deleteSessionPrivateFirst } = await import("../../src/kilo-provider/session-delete")
    const dir = "/repo/sdk-strict"
    const sessionId = "ses_sdk_strict"
    const makeConn = () => ({ isPrivateAvailable: () => false, getServerConfig: () => null } as unknown as never)
    const cases: Array<[string, unknown]> = [
      ["false", false],
      ["undefined", undefined],
      ["null", null],
      ["empty object", {}],
      ["empty string", ""],
      ["number 1", 1],
      ["string true", "true"],
    ]
    for (const [label, data] of cases) {
      const sdk = async () => ({ data, error: undefined })
      const client = { session: { delete: sdk } } as unknown as import("@kilocode/sdk/v2/client").KiloClient
      const conn = makeConn()
      let threw = false
      try {
        await deleteSessionPrivateFirst({ client, connection: conn, sessionId, directory: dir })
      } catch {
        threw = true
      }
      expect(threw).toBeTrue()
    }
    // true must succeed
    {
      const sdk = async () => ({ data: true, error: undefined })
      const client = { session: { delete: sdk } } as unknown as import("@kilocode/sdk/v2/client").KiloClient
      const conn = makeConn()
      await deleteSessionPrivateFirst({ client, connection: conn, sessionId, directory: dir })
    }
  })
})
