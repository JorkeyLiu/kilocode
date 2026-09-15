import { describe, expect, test } from "bun:test"
import { sandboxStatusHandle } from "./serve-private-sandbox-status-connection"

function req() {
  return { v: 1 as const, requestId: "r-conn", op: "sandbox/status" as const, context: { directory: "/tmp", sessionId: "ses_conn1" }, payload: {} }
}

function okWire(r: ReturnType<typeof req>) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      op: "sandbox/status",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { status: { directory: "/tmp", enabled: true, available: true, version: 1 } },
    },
  }
}

function terminalWire(r: ReturnType<typeof req>) {
  const failure = { code: "session.not_found", message: "session not found", retryable: false }
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      op: "sandbox/status",
      status: "failed",
      outcome: { type: "failed", time: 1, failure },
      accepted: false,
      failure,
    },
  }
}

function retryableWire(r: ReturnType<typeof req>) {
  const failure = { code: "internal", message: "internal error", retryable: true }
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      op: "sandbox/status",
      status: "failed",
      outcome: { type: "failed", time: 1, failure },
      accepted: false,
      failure,
    },
  }
}

describe("sandboxStatusHandle epoch ownership", () => {
  test("missing capability fails closed before any transport work", () => {
    const r = req()
    const peer = {
      isAvailable: () => true,
      hasCapability: () => false,
      privateSandboxStatusOutcomeWithHandle: () => { throw new Error("must not be called") },
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    expect(() => sandboxStatusHandle({ peer: peer as never, live: true, epoch: 1, invalidate: () => {} }, r)).toThrow(
      "sandbox/status capability",
    )
  })

  test("settled success/terminal preserved across post-response drift", async () => {
    for (const wire of [okWire(req()), terminalWire(req())]) {
      const r = req()
      const w = wire.kind === "valid" && (wire.result as { status: string }).status === "succeeded" ? okWire(r) : terminalWire(r)
      let epoch = 1
      const peer = {
        isAvailable: () => true,
        hasCapability: () => true,
        privateSandboxStatusOutcomeWithHandle: () => ({ id: 1, promise: Promise.resolve(w) }),
        tryCancelPending: () => true,
        invalidateOnObserverTimeout: () => {},
      }
      const deps = { peer: peer as never, live: true, epoch, invalidate: () => {} }
      const handle = sandboxStatusHandle({ ...deps, get epoch() { return epoch } } as never, r)
      epoch = 2
      const out = await handle.promise
      expect(out.kind).toBe("valid")
      if (out.kind === "valid") expect((out.result as { status: string }).status).toBe((w.result as { status: string }).status)
    }
  })

  test("unresolved retryable drift maps to ambiguous", async () => {
    const r = req()
    let epoch = 1
    const peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      privateSandboxStatusOutcomeWithHandle: () => ({ id: 2, promise: Promise.resolve(retryableWire(r)) }),
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    const handle = sandboxStatusHandle({ peer: peer as never, live: true, get epoch() { return epoch } } as never, r)
    epoch = 2
    const out = await handle.promise
    expect(out.kind).toBe("valid")
    if (out.kind === "valid") expect((out.result as { status: string }).status).toBe("ambiguous")
  })

  test("exact cancel preserves peer while current, stale cleans only captured", () => {
    const r = req()
    const peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      privateSandboxStatusOutcomeWithHandle: () => ({ id: 7, promise: Promise.resolve(okWire(r)) }),
      tryCancelPending: (id: number) => id === 7,
      invalidateOnObserverTimeout: () => {},
    }
    let invalidated = 0
    const handle = sandboxStatusHandle({ peer: peer as never, live: true, epoch: 1, invalidate: () => { invalidated += 1 } }, r)
    expect(handle.cancel("private parity timeout")).toBeTrue()
    expect(invalidated).toBe(0)
  })
})
