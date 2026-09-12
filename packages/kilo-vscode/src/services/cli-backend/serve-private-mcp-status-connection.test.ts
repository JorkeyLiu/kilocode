import { describe, expect, test } from "bun:test"
import { mcpStatusOutcomeHandle } from "./serve-private-mcp-status-connection"
import {
  canonicalMcpStatusOpId,
  isSettledMcpStatusResult,
  makeMcpStatusAmbiguous,
} from "./serve-private-mcp-status-contract"
import { wrapEpochHandle } from "./serve-private-epoch"

function req(token = "tok1") {
  const opId = canonicalMcpStatusOpId(token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "mcp/status" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
  }
}

function okFor(r: ReturnType<typeof req>) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: "mcp/status",
      idempotencyKey: r.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { status: { docs: { status: "connected" } } },
    },
  }
}

function stubPeer(outcome: unknown, caps: string[] = ["mcp/status"]) {
  return {
    isAvailable: () => true,
    hasCapability: (c: string) => caps.includes(c),
    privateMcpStatusOutcomeWithHandle: () => ({
      id: 3,
      promise: Promise.resolve(outcome),
      cancel: () => true,
    }),
    tryCancelPending: () => true,
    invalidateOnObserverTimeout: () => {},
  }
}

describe("mcp-status connection handle", () => {
  test("unavailable peer throws without touching the transport", () => {
    const r = req()
    expect(() => mcpStatusOutcomeHandle({ peer: null, live: true, epoch: 7, invalidate: () => {} }, r)).toThrow(
      "Private peer unavailable",
    )
  })

  test("missing capability throws fail-closed", () => {
    const r = req()
    const peer = stubPeer(okFor(r), ["session/get"])
    expect(() =>
      mcpStatusOutcomeHandle({ peer: peer as never, live: true, epoch: 7, invalidate: () => {} }, r),
    ).toThrow("Private peer missing mcp/status capability")
  })

  test("current epoch passes the normalized outcome through", async () => {
    const r = req()
    const peer = stubPeer(okFor(r))
    const handle = mcpStatusOutcomeHandle({ peer: peer as never, live: true, epoch: 7, invalidate: () => {} }, r)
    expect(handle.id).toBe(3)
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") expect(outcome.result.status).toBe("succeeded")
  })

  test("invalid wire passes through before any fallback", async () => {
    const r = req()
    const peer = stubPeer({ kind: "invalid", detail: "bad wire" })
    const handle = mcpStatusOutcomeHandle({ peer: peer as never, live: true, epoch: 7, invalidate: () => {} }, r)
    const outcome = await handle.promise
    expect(outcome.kind).toBe("invalid")
  })

  test("settled success survives post-response epoch drift", async () => {
    const r = req()
    let release: ((v: unknown) => void) | null = null
    const gate = new Promise<unknown>((resolve) => {
      release = resolve
    })
    const peer = stubPeer(null)
    const conn = { peer: peer as never, live: true, epoch: 7 as number | null, invalidate: () => {} }
    const handle = wrapEpochHandle({
      conn,
      cap: "mcp/status",
      req: r,
      call: () => ({ id: 3, promise: gate, cancel: () => true }),
      vague: (q) => ({ kind: "valid" as const, result: makeMcpStatusAmbiguous(q, true) }),
      settled: (outcome, want) => {
        if (outcome.kind !== "valid") return false
        return isSettledMcpStatusResult(outcome.result, want)
      },
    })
    conn.epoch = 8
    release!(okFor(r))
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") expect(outcome.result.status).toBe("succeeded")
  })

  test("unsettled drift maps to ambiguous transportUnknown", async () => {
    const r = req()
    let release: ((v: unknown) => void) | null = null
    const gate = new Promise<unknown>((resolve) => {
      release = resolve
    })
    const retryable = {
      kind: "valid" as const,
      result: {
        v: 1,
        requestId: r.requestId,
        opId: r.opId,
        op: "mcp/status",
        idempotencyKey: r.idempotencyKey,
        status: "failed",
        outcome: {
          type: "failed",
          time: 1,
          failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
        },
        accepted: false,
        failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
      },
    }
    const peer = stubPeer(null)
    const conn = { peer: peer as never, live: true, epoch: 7 as number | null, invalidate: () => {} }
    const handle = wrapEpochHandle({
      conn,
      cap: "mcp/status",
      req: r,
      call: () => ({ id: 3, promise: gate, cancel: () => true }),
      vague: (q) => ({ kind: "valid" as const, result: makeMcpStatusAmbiguous(q, true) }),
      settled: (outcome, want) => {
        if (outcome.kind !== "valid") return false
        return isSettledMcpStatusResult(outcome.result, want)
      },
    })
    conn.epoch = 8
    release!(retryable)
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") {
      expect(outcome.result.status).toBe("ambiguous")
      expect((outcome.result as Record<string, unknown>).transportUnknown).toBeTrue()
    }
  })

  test("current-epoch cancel miss invalidates the owner", () => {
    const r = req()
    let invalidated = 0
    const peer = { ...stubPeer(okFor(r)), tryCancelPending: () => false }
    const handle = mcpStatusOutcomeHandle(
      { peer: peer as never, live: true, epoch: 7, invalidate: () => (invalidated += 1) },
      r,
    )
    expect(handle.cancel()).toBeFalse()
    expect(invalidated).toBe(1)
  })
})
