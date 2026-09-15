import { describe, expect, test } from "bun:test"
import { ServePrivatePeer } from "./serve-private-peer"
import type { SessionViewedContractRequest } from "./serve-private-session-viewed-contract"

const uid = "11111111-1111-4111-8111-111111111111"

function req(): SessionViewedContractRequest {
  return {
    v: 1,
    requestId: "r-viewed-1",
    op: "session/viewed",
    context: { directory: "/tmp" },
    payload: { viewer: { id: uid, active: true, sequence: 1 }, attached: ["ses_a"], visible: ["ses_a"] },
  }
}

function peerWith(caps: string[], handler: (method: string) => Promise<unknown>) {
  const peer = new ServePrivatePeer({ reader: null as never, writer: null as never, pid: 1, epoch: 1, process: null as never })
  ;(peer as unknown as { available: boolean }).available = true
  ;(peer as unknown as { capabilities: string[] }).capabilities = caps
  ;(peer as unknown as { peer: unknown }).peer = {
    getState: () => "open",
    requestWithId: (method: string, params: unknown) => ({ id: 7, promise: handler(method).then(() => params).then(() => handler(method)) }),
  }
  return peer
}

describe("ServePrivatePeer session/viewed", () => {
  test("missing capability throws before transport", () => {
    const peer = peerWith([], async () => ({}))
    expect(() => peer.privateSessionViewedOutcomeWithHandle(req() as never)).toThrow("session/viewed capability")
  })

  test("unavailable peer throws before transport", () => {
    const peer = peerWith(["session/viewed"], async () => ({}))
    ;(peer as unknown as { available: boolean }).available = false
    expect(() => peer.privateSessionViewedOutcomeWithHandle(req() as never)).toThrow("Private peer unavailable")
  })

  test("valid succeeded wire resolves as valid", async () => {
    const r = req()
    const raw = {
      v: 1,
      requestId: r.requestId,
      op: "session/viewed",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { applied: true },
    }
    const peer = new ServePrivatePeer({ reader: null as never, writer: null as never, pid: 1, epoch: 1, process: null as never })
    ;(peer as unknown as { available: boolean }).available = true
    ;(peer as unknown as { capabilities: string[] }).capabilities = ["session/viewed"]
    ;(peer as unknown as { peer: unknown }).peer = {
      getState: () => "open",
      requestWithId: () => ({ id: 11, promise: Promise.resolve(raw) }),
    }
    const outcome = await peer.privateSessionViewedOutcomeWithHandle(r).promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") expect(outcome.result.status).toBe("succeeded")
  })

  test("invalid wire resolves as invalid, closed maps to ambiguous", async () => {
    const r = req()
    const peer = new ServePrivatePeer({ reader: null as never, writer: null as never, pid: 1, epoch: 1, process: null as never })
    ;(peer as unknown as { available: boolean }).available = true
    ;(peer as unknown as { capabilities: string[] }).capabilities = ["session/viewed"]
    ;(peer as unknown as { peer: unknown }).peer = {
      getState: () => "open",
      requestWithId: () => ({ id: 12, promise: Promise.resolve({ bogus: true }) }),
    }
    const bad = await peer.privateSessionViewedOutcomeWithHandle(r).promise
    expect(bad.kind).toBe("invalid")

    const closed = new ServePrivatePeer({ reader: null as never, writer: null as never, pid: 1, epoch: 1, process: null as never })
    ;(closed as unknown as { available: boolean }).available = true
    ;(closed as unknown as { capabilities: string[] }).capabilities = ["session/viewed"]
    const err = Object.assign(new Error("Peer closed"), { code: -32603 })
    ;(closed as unknown as { peer: unknown }).peer = {
      getState: () => "open",
      requestWithId: () => ({ id: 13, promise: Promise.reject(err) }),
    }
    const out = await closed.privateSessionViewedOutcomeWithHandle(r).promise
    expect(out.kind).toBe("valid")
    if (out.kind === "valid") expect(out.result.status).toBe("ambiguous")
  })

  test("generic peer rejection synthesizes retryable failure, never terminal", async () => {
    const r = req()
    const peer = new ServePrivatePeer({ reader: null as never, writer: null as never, pid: 1, epoch: 1, process: null as never })
    ;(peer as unknown as { available: boolean }).available = true
    ;(peer as unknown as { capabilities: string[] }).capabilities = ["session/viewed"]
    ;(peer as unknown as { peer: unknown }).peer = {
      getState: () => "open",
      requestWithId: () => ({ id: 14, promise: Promise.reject(new Error("boom")) }),
    }
    const retryable = await peer.privateSessionViewedOutcomeWithHandle(r).promise
    expect(retryable.kind).toBe("valid")
    if (retryable.kind === "valid") {
      expect(retryable.result.status).toBe("failed")
      if (retryable.result.status === "failed") {
        expect(retryable.result.accepted).toBe(false)
        expect(retryable.result.failure.retryable).toBe(true)
      }
      const { isSettledSessionViewedResult } = await import("./serve-private-session-viewed-contract")
      expect(isSettledSessionViewedResult(retryable.result, r)).toBe(false)
    } else throw new Error("expected valid retryable failure")
  })
})
