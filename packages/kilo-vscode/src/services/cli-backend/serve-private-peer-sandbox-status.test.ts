import { describe, expect, test } from "bun:test"
import { ServePrivatePeer } from "./serve-private-peer"

function req(dir = "/tmp/peer-sandbox-status") {
  return { v: 1 as const, requestId: "r-peer", op: "sandbox/status" as const, context: { directory: dir, sessionId: "ses_peer1" }, payload: {} }
}

function okResult(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "sandbox/status",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status: { directory: r.context.directory, enabled: false, available: false, version: 0 } },
  }
}

describe("serve-private-peer sandbox/status", () => {
  test("missing capability fails closed", () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = []
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = { getState: () => "open" }
    const r = req()
    expect(() => peer.privateSandboxStatusOutcomeWithHandle(r as never)).toThrow("sandbox/status capability")
  })

  test("unavailable peer fails closed", () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = ["sandbox/status"]
    expect(() => peer.privateSandboxStatusOutcomeWithHandle(req() as never)).toThrow("Private peer unavailable")
  })

  test("valid wire normalizes, invalid wire is explicit invalid, generic rejection stays fallback-eligible", async () => {
    const peer = new ServePrivatePeer({} as never)
    ;(peer as unknown as Record<string, unknown>).capabilities = ["sandbox/status"]
    const rawPeer = {
      getState: () => "open",
      requestWithId: (_m: string, r: ReturnType<typeof req>) => ({ id: 1, promise: Promise.resolve(okResult(r)) }),
    }
    ;(peer as unknown as Record<string, unknown>).peer = rawPeer
    ;(peer as unknown as Record<string, unknown>).available = true
    const r = req()
    const outcome = await peer.privateSandboxStatusOutcomeWithHandle(r as never).promise
    expect(outcome.kind).toBe("valid")

    const badPeer = {
      getState: () => "open",
      requestWithId: () => ({ id: 2, promise: Promise.resolve({ v: 1, bad: true }) }),
    }
    ;(peer as unknown as Record<string, unknown>).peer = badPeer
    const bad = await peer.privateSandboxStatusOutcomeWithHandle(r as never).promise
    expect(bad.kind).toBe("invalid")

    // Generic transport rejection synthesizes an unknown failure code, which
    // fails closed validation at the helper (fallback-eligible, never terminal).
    const rejectPeer = {
      getState: () => "open",
      requestWithId: () => ({ id: 3, promise: Promise.reject(Object.assign(new Error("boom"), { code: -32603 })) }),
    }
    ;(peer as unknown as Record<string, unknown>).peer = rejectPeer
    const closed = await peer.privateSandboxStatusOutcomeWithHandle(r as never).promise
    expect(closed.kind).toBe("valid")
    if (closed.kind === "valid") expect((closed.result as { status: string }).status).toBe("ambiguous")
  })
})
