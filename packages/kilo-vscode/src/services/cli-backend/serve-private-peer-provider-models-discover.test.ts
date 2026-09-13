import { describe, expect, test } from "bun:test"
import { ServePrivatePeer } from "./serve-private-peer"

function req(dir = "/tmp/peer-discover") {
  return {
    v: 1 as const,
    requestId: "r-peer",
    op: "provider/models-discover" as const,
    context: { directory: dir },
    payload: { providerID: "test", baseURL: "https://example.com/v1" },
  }
}

function okResult(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "provider/models-discover",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { models: [{ id: "m1", name: "M1" }] },
  }
}

describe("serve-private-peer provider/models-discover", () => {
  test("missing capability fails closed", () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = []
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = { getState: () => "open" }
    expect(() => peer.privateProviderModelsDiscoverOutcomeWithHandle(req() as never)).toThrow(
      "provider/models-discover capability",
    )
  })

  test("unavailable peer fails closed", () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = ["provider/models-discover"]
    expect(() => peer.privateProviderModelsDiscoverOutcomeWithHandle(req() as never)).toThrow(
      "Private peer unavailable",
    )
  })

  test("valid wire normalizes, invalid wire is explicit invalid, secret wire invalid", async () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = ["provider/models-discover"]
    const rawPeer = {
      getState: () => "open",
      requestWithId: (_m: string, r: ReturnType<typeof req>) => ({ id: 1, promise: Promise.resolve(okResult(r)) }),
    }
    ;(peer as unknown as Record<string, unknown>).peer = rawPeer
    ;(peer as unknown as Record<string, unknown>).available = true
    const r = req()
    const outcome = await peer.privateProviderModelsDiscoverOutcomeWithHandle(r as never).promise
    expect(outcome.kind).toBe("valid")

    const badPeer = {
      getState: () => "open",
      requestWithId: () => ({ id: 2, promise: Promise.resolve({ v: 1, bad: true }) }),
    }
    ;(peer as unknown as Record<string, unknown>).peer = badPeer
    const bad = await peer.privateProviderModelsDiscoverOutcomeWithHandle(r as never).promise
    expect(bad.kind).toBe("invalid")

    const secret = okResult(r)
    ;((secret.data.models as Record<string, unknown>[])[0] as Record<string, unknown>)["key"] = "sk-leak"
    const secretPeer = { getState: () => "open", requestWithId: () => ({ id: 3, promise: Promise.resolve(secret) }) }
    ;(peer as unknown as Record<string, unknown>).peer = secretPeer
    const leaked = await peer.privateProviderModelsDiscoverOutcomeWithHandle(r as never).promise
    expect(leaked.kind).toBe("invalid")
  })
})
