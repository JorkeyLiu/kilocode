import { describe, expect, test } from "bun:test"
import { ServePrivatePeer } from "./serve-private-peer"

function req(dir = "/tmp/peer-auth") {
  return { v: 1 as const, requestId: "r-peer", op: "provider/auth" as const, context: { directory: dir }, payload: {} }
}

function okResult(r: ReturnType<typeof req>) {
  return {
    v: 1, requestId: r.requestId, op: "provider/auth", status: "succeeded",
    outcome: { type: "succeeded", time: 1 }, accepted: true,
    data: { openai: [{ type: "api", label: "API" }] },
  }
}

describe("serve-private-peer provider/auth", () => {
  test("missing capability fails closed", () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = []
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = { getState: () => "open" }
    expect(() => peer.privateProviderAuthOutcomeWithHandle(req() as never)).toThrow("provider/auth capability")
  })

  test("unavailable peer fails closed", () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = ["provider/auth"]
    expect(() => peer.privateProviderAuthOutcomeWithHandle(req() as never)).toThrow("Private peer unavailable")
  })

  test("valid wire normalizes, invalid wire is explicit invalid, unknown nested invalid", async () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = ["provider/auth"]
    const rawPeer = {
      getState: () => "open",
      requestWithId: (_m: string, r: ReturnType<typeof req>) => ({ id: 1, promise: Promise.resolve(okResult(r)) }),
    }
    ;(peer as unknown as Record<string, unknown>).peer = rawPeer
    ;(peer as unknown as Record<string, unknown>).available = true
    const r = req()
    const outcome = await peer.privateProviderAuthOutcomeWithHandle(r as never).promise
    expect(outcome.kind).toBe("valid")

    const badPeer = { getState: () => "open", requestWithId: () => ({ id: 2, promise: Promise.resolve({ v: 1, bad: true }) }) }
    ;(peer as unknown as Record<string, unknown>).peer = badPeer
    const bad = await peer.privateProviderAuthOutcomeWithHandle(r as never).promise
    expect(bad.kind).toBe("invalid")

    const nested = okResult(r)
    ;((nested.data.openai[0] as Record<string, unknown>).prompts as unknown[])?.push?.({ type: "text", key: "k", message: "m", extra: 1 })
    ;(nested.data.openai[0] as Record<string, unknown>).prompts = [{ type: "text", key: "k", message: "m", extra: 1 }]
    const nestedPeer = { getState: () => "open", requestWithId: () => ({ id: 3, promise: Promise.resolve(nested) }) }
    ;(peer as unknown as Record<string, unknown>).peer = nestedPeer
    const leaked = await peer.privateProviderAuthOutcomeWithHandle(r as never).promise
    expect(leaked.kind).toBe("invalid")
  })
})
