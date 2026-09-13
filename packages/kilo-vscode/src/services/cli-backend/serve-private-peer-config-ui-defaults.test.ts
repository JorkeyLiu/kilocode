import { describe, expect, test } from "bun:test"
import { ServePrivatePeer } from "./serve-private-peer"

function req(dir = "/tmp/peer-ui-defaults") {
  return { v: 1 as const, requestId: "r-peer", op: "config/ui-defaults" as const, context: { directory: dir }, payload: {} }
}

function okResult(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "config/ui-defaults",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { workStyle: { hasPermission: false }, sandbox: { enabled: false } },
  }
}

describe("serve-private-peer config/ui-defaults", () => {
  test("missing capability fails closed", () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = []
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = { getState: () => "open" }
    const r = req()
    expect(() => peer.privateConfigUiDefaultsOutcomeWithHandle(r as never)).toThrow("config/ui-defaults capability")
  })

  test("unavailable peer fails closed", () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = ["config/ui-defaults"]
    expect(() => peer.privateConfigUiDefaultsOutcomeWithHandle(req() as never)).toThrow("Private peer unavailable")
  })

  test("valid wire normalizes, invalid wire is explicit invalid", async () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = ["config/ui-defaults"]
    const rawPeer = {
      getState: () => "open",
      requestWithId: (_m: string, r: ReturnType<typeof req>) => ({ id: 1, promise: Promise.resolve(okResult(r)) }),
    }
    ;(peer as unknown as Record<string, unknown>).peer = rawPeer
    ;(peer as unknown as Record<string, unknown>).available = true
    const r = req()
    const outcome = await peer.privateConfigUiDefaultsOutcomeWithHandle(r as never).promise
    expect(outcome.kind).toBe("valid")

    const badPeer = {
      getState: () => "open",
      requestWithId: () => ({ id: 2, promise: Promise.resolve({ v: 1, bad: true }) }),
    }
    ;(peer as unknown as Record<string, unknown>).peer = badPeer
    const bad = await peer.privateConfigUiDefaultsOutcomeWithHandle(r as never).promise
    expect(bad.kind).toBe("invalid")
  })
})
