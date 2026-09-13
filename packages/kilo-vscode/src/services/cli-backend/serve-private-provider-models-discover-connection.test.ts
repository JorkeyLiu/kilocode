import { describe, expect, test } from "bun:test"
import { providerModelsDiscoverHandle } from "./serve-private-provider-models-discover-connection"

function req() {
  return {
    v: 1 as const,
    requestId: "r-conn",
    op: "provider/models-discover" as const,
    context: { directory: "/tmp" },
    payload: { providerID: "test", baseURL: "https://example.com/v1" },
  }
}

function okWire(r: ReturnType<typeof req>) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      op: "provider/models-discover",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { models: [{ id: "m1", name: "M1" }] },
    },
  }
}

function terminalWire(r: ReturnType<typeof req>) {
  const failure = { code: "unauthorized", message: "stored credential failed authentication", retryable: false }
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      op: "provider/models-discover",
      status: "failed",
      outcome: { type: "failed", time: 1, failure },
      accepted: false,
      failure,
    },
  }
}

function retryableWire(r: ReturnType<typeof req>) {
  const failure = {
    code: "InstanceUnavailableDuringConfigRebuild",
    message: "Instance is unavailable during config rebuild; no active runtime for this request",
    retryable: true,
  }
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      op: "provider/models-discover",
      status: "failed",
      outcome: { type: "failed", time: 1, failure },
      accepted: false,
      failure,
    },
  }
}

describe("providerModelsDiscoverHandle epoch ownership", () => {
  test("missing capability fails closed before any transport work", () => {
    const r = req()
    const peer = {
      isAvailable: () => true,
      hasCapability: () => false,
      privateProviderModelsDiscoverOutcomeWithHandle: () => {
        throw new Error("must not be called")
      },
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    expect(() =>
      providerModelsDiscoverHandle({ peer: peer as never, live: true, epoch: 1, invalidate: () => {} }, r),
    ).toThrow("provider/models-discover capability")
  })

  test("settled success/terminal preserved across post-response drift", async () => {
    for (const maker of [okWire, terminalWire]) {
      const r = req()
      const w = maker(r)
      let epoch = 1
      const peer = {
        isAvailable: () => true,
        hasCapability: () => true,
        privateProviderModelsDiscoverOutcomeWithHandle: () => ({ id: 1, promise: Promise.resolve(w) }),
        tryCancelPending: () => true,
        invalidateOnObserverTimeout: () => {},
      }
      const handle = providerModelsDiscoverHandle(
        {
          peer: peer as never,
          live: true,
          get epoch() {
            return epoch
          },
        } as never,
        r,
      )
      epoch = 2
      const out = await handle.promise
      expect(out.kind).toBe("valid")
      if (out.kind === "valid")
        expect((out.result as { status: string }).status).toBe((w.result as { status: string }).status)
    }
  })

  test("unresolved retryable drift maps to ambiguous", async () => {
    const r = req()
    let epoch = 1
    const peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      privateProviderModelsDiscoverOutcomeWithHandle: () => ({ id: 2, promise: Promise.resolve(retryableWire(r)) }),
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    const handle = providerModelsDiscoverHandle(
      {
        peer: peer as never,
        live: true,
        get epoch() {
          return epoch
        },
      } as never,
      r,
    )
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
      privateProviderModelsDiscoverOutcomeWithHandle: () => ({ id: 7, promise: Promise.resolve(okWire(r)) }),
      tryCancelPending: (id: number) => id === 7,
      invalidateOnObserverTimeout: () => {},
    }
    let invalidated = 0
    const handle = providerModelsDiscoverHandle(
      {
        peer: peer as never,
        live: true,
        epoch: 1,
        invalidate: () => {
          invalidated += 1
        },
      },
      r,
    )
    expect(handle.cancel("private parity timeout")).toBeTrue()
    expect(invalidated).toBe(0)
  })
})
