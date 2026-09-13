import { describe, expect, test } from "bun:test"
import { providerAuthHandle } from "./serve-private-provider-auth-connection"

function req() {
  return { v: 1 as const, requestId: "r-conn", op: "provider/auth" as const, context: { directory: "/tmp" }, payload: {} }
}

function okWire(r: ReturnType<typeof req>) {
  return {
    kind: "valid" as const,
    result: {
      v: 1, requestId: r.requestId, op: "provider/auth", status: "succeeded",
      outcome: { type: "succeeded", time: 1 }, accepted: true,
      data: { openai: [{ type: "api", label: "API" }] },
    },
  }
}

function terminalWire(r: ReturnType<typeof req>) {
  const failure = { code: "validation.failed", message: "invalid provider-auth request", retryable: false }
  return { kind: "valid" as const, result: { v: 1, requestId: r.requestId, op: "provider/auth", status: "failed", outcome: { type: "failed", time: 1, failure }, accepted: false, failure } }
}

function retryableWire(r: ReturnType<typeof req>) {
  const failure = { code: "InstanceUnavailableDuringConfigRebuild", message: "Instance is unavailable during config rebuild; no active runtime for this request", retryable: true }
  return { kind: "valid" as const, result: { v: 1, requestId: r.requestId, op: "provider/auth", status: "failed", outcome: { type: "failed", time: 1, failure }, accepted: false, failure } }
}

describe("providerAuthHandle epoch ownership", () => {
  test("missing capability fails closed before any transport work", () => {
    const r = req()
    const peer = {
      isAvailable: () => true,
      hasCapability: () => false,
      privateProviderAuthOutcomeWithHandle: () => { throw new Error("must not be called") },
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    expect(() => providerAuthHandle({ peer: peer as never, live: true, epoch: 1, invalidate: () => {} }, r)).toThrow("provider/auth capability")
  })

  test("settled success/terminal preserved across post-response drift", async () => {
    for (const maker of [okWire, terminalWire]) {
      const r = req()
      const w = maker(r)
      let epoch = 1
      const peer = {
        isAvailable: () => true,
        hasCapability: () => true,
        privateProviderAuthOutcomeWithHandle: () => ({ id: 1, promise: Promise.resolve(w) }),
        tryCancelPending: () => true,
        invalidateOnObserverTimeout: () => {},
      }
      const handle = providerAuthHandle({ peer: peer as never, live: true, get epoch() { return epoch } } as never, r)
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
      privateProviderAuthOutcomeWithHandle: () => ({ id: 2, promise: Promise.resolve(retryableWire(r)) }),
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    const handle = providerAuthHandle({ peer: peer as never, live: true, get epoch() { return epoch } } as never, r)
    epoch = 2
    const out = await handle.promise
    expect(out.kind).toBe("valid")
    if (out.kind === "valid") expect((out.result as { status: string }).status).toBe("ambiguous")
  })

  test("exact cancel preserves peer while current", () => {
    const r = req()
    const peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      privateProviderAuthOutcomeWithHandle: () => ({ id: 7, promise: Promise.resolve(okWire(r)) }),
      tryCancelPending: (id: number) => id === 7,
      invalidateOnObserverTimeout: () => {},
    }
    let invalidated = 0
    const handle = providerAuthHandle({ peer: peer as never, live: true, epoch: 1, invalidate: () => { invalidated += 1 } }, r)
    expect(handle.cancel("private parity timeout")).toBeTrue()
    expect(invalidated).toBe(0)
  })
})
