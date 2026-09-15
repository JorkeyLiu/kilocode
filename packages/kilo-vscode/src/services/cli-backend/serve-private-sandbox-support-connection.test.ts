import { describe, expect, test } from "bun:test"
import { sandboxSupportHandle } from "./serve-private-sandbox-support-connection"

function req() {
  return { v: 1 as const, requestId: "r-conn", op: "sandbox/support" as const, context: { directory: "/tmp" }, payload: {} }
}

function okWire(r: ReturnType<typeof req>) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      op: "sandbox/support",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { available: true },
    },
  }
}

function terminalWire(r: ReturnType<typeof req>) {
  const failure = { code: "validation.failed", message: "invalid sandbox support request", retryable: false }
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      op: "sandbox/support",
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
      op: "sandbox/support",
      status: "failed",
      outcome: { type: "failed", time: 1, failure },
      accepted: false,
      failure,
    },
  }
}

describe("sandboxSupportHandle epoch ownership", () => {
  test("missing capability fails closed before any transport work", () => {
    const r = req()
    const peer = {
      isAvailable: () => true,
      hasCapability: () => false,
      privateSandboxSupportOutcomeWithHandle: () => { throw new Error("must not be called") },
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    expect(() => sandboxSupportHandle({ peer: peer as never, live: true, epoch: 1, invalidate: () => {} }, r)).toThrow(
      "sandbox/support capability",
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
        privateSandboxSupportOutcomeWithHandle: () => ({ id: 1, promise: Promise.resolve(w) }),
        tryCancelPending: () => true,
        invalidateOnObserverTimeout: () => {},
      }
      const deps = { peer: peer as never, live: true, epoch, invalidate: () => {} }
      const handle = sandboxSupportHandle({ ...deps, get epoch() { return epoch } } as never, r)
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
      privateSandboxSupportOutcomeWithHandle: () => ({ id: 2, promise: Promise.resolve(retryableWire(r)) }),
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    const handle = sandboxSupportHandle({ peer: peer as never, live: true, get epoch() { return epoch } } as never, r)
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
      privateSandboxSupportOutcomeWithHandle: () => ({ id: 7, promise: Promise.resolve(okWire(r)) }),
      tryCancelPending: (id: number) => id === 7,
      invalidateOnObserverTimeout: () => {},
    }
    let invalidated = 0
    const handle = sandboxSupportHandle({ peer: peer as never, live: true, epoch: 1, invalidate: () => { invalidated += 1 } }, r)
    expect(handle.cancel("private parity timeout")).toBeTrue()
    expect(invalidated).toBe(0)
  })
})
