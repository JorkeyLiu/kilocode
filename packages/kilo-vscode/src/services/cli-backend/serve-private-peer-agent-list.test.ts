import { describe, expect, test } from "bun:test"
import { ServePrivatePeer } from "./serve-private-peer"

function req(dir = "/tmp/peer-agent") {
  return { v: 1 as const, requestId: "r-peer", op: "agent/list" as const, context: { directory: dir }, payload: {} }
}

function okResult(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "agent/list",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { agents: [{ name: "code", mode: "primary", permission: [], options: {} }] },
  }
}

describe("serve-private-peer agent/list", () => {
  test("missing capability fails closed", () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = []
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = { getState: () => "open" }
    const r = req()
    expect(() => peer.privateAgentListOutcomeWithHandle(r as never)).toThrow("agent/list capability")
  })

  test("unavailable peer fails closed", () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = ["agent/list"]
    expect(() => peer.privateAgentListOutcomeWithHandle(req() as never)).toThrow("Private peer unavailable")
  })

  test("valid wire normalizes, invalid wire is explicit invalid", async () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = ["agent/list"]
    const rawPeer = {
      getState: () => "open",
      requestWithId: (_m: string, r: ReturnType<typeof req>) => ({ id: 1, promise: Promise.resolve(okResult(r)) }),
    }
    ;(peer as unknown as Record<string, unknown>).peer = rawPeer
    ;(peer as unknown as Record<string, unknown>).available = true
    const r = req()
    const outcome = await peer.privateAgentListOutcomeWithHandle(r as never).promise
    expect(outcome.kind).toBe("valid")

    const badPeer = {
      getState: () => "open",
      requestWithId: () => ({ id: 2, promise: Promise.resolve({ v: 1, bad: true }) }),
    }
    ;(peer as unknown as Record<string, unknown>).peer = badPeer
    const bad = await peer.privateAgentListOutcomeWithHandle(r as never).promise
    expect(bad.kind).toBe("invalid")
  })
})
