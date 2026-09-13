import { describe, expect, test } from "bun:test"
import { ServePrivatePeer } from "./serve-private-peer"

function req(dir = "/tmp/peer-catalog") {
  return { v: 1 as const, requestId: "r-peer", op: "provider/catalog" as const, context: { directory: dir }, payload: {} }
}

function caps() {
  return {
    temperature: true, reasoning: false, attachment: false, toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  }
}

function okResult(r: ReturnType<typeof req>) {
  return {
    v: 1, requestId: r.requestId, op: "provider/catalog", status: "succeeded",
    outcome: { type: "succeeded", time: 1 }, accepted: true,
    data: {
      all: [{ id: "openai", name: "OpenAI", source: "api", env: [], hasCredential: false, models: {} }],
      default: {}, connected: [], failed: [],
    },
  }
}

describe("serve-private-peer provider/catalog", () => {
  test("missing capability fails closed", () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = []
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = { getState: () => "open" }
    expect(() => peer.privateProviderCatalogOutcomeWithHandle(req() as never)).toThrow("provider/catalog capability")
  })

  test("unavailable peer fails closed", () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = ["provider/catalog"]
    expect(() => peer.privateProviderCatalogOutcomeWithHandle(req() as never)).toThrow("Private peer unavailable")
  })

  test("valid wire normalizes, invalid wire is explicit invalid, secret wire invalid", async () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = ["provider/catalog"]
    const rawPeer = {
      getState: () => "open",
      requestWithId: (_m: string, r: ReturnType<typeof req>) => ({ id: 1, promise: Promise.resolve(okResult(r)) }),
    }
    ;(peer as unknown as Record<string, unknown>).peer = rawPeer
    ;(peer as unknown as Record<string, unknown>).available = true
    const r = req()
    const outcome = await peer.privateProviderCatalogOutcomeWithHandle(r as never).promise
    expect(outcome.kind).toBe("valid")

    const badPeer = { getState: () => "open", requestWithId: () => ({ id: 2, promise: Promise.resolve({ v: 1, bad: true }) }) }
    ;(peer as unknown as Record<string, unknown>).peer = badPeer
    const bad = await peer.privateProviderCatalogOutcomeWithHandle(r as never).promise
    expect(bad.kind).toBe("invalid")

    const secret = okResult(r)
    ;((secret.data.all[0] as Record<string, unknown>).models as Record<string, unknown>)["m"] = {
      id: "m", providerID: "openai", api: { id: "m", url: "https://x", npm: "n" }, name: "M",
      capabilities: caps(), cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
      limit: { context: 1, output: 1 }, status: "active", release_date: "2024-01-01",
      options: { secret: "sk-leak" },
    }
    const secretPeer = { getState: () => "open", requestWithId: () => ({ id: 3, promise: Promise.resolve(secret) }) }
    ;(peer as unknown as Record<string, unknown>).peer = secretPeer
    const leaked = await peer.privateProviderCatalogOutcomeWithHandle(r as never).promise
    expect(leaked.kind).toBe("invalid")
  })
})
