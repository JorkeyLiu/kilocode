import { describe, expect, test } from "bun:test"
import { instanceReloadHandle } from "./serve-private-instance-reload-connection"
import { canonicalInstanceReloadOpId } from "./serve-private-instance-reload-contract"

function req(token = "tok-conn") {
  const opId = canonicalInstanceReloadOpId(token)
  return {
    v: 1 as const,
    requestId: `req-${token}`,
    opId,
    op: "instance/reload" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
  }
}

function okWire(r: ReturnType<typeof req>) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: r.op,
      idempotencyKey: r.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { reloaded: true },
    },
  }
}

function terminalWire(r: ReturnType<typeof req>) {
  const failure = { code: "conflict", message: "Cannot reload while a session is running.", retryable: false }
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: r.op,
      idempotencyKey: r.idempotencyKey,
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
      opId: r.opId,
      op: r.op,
      idempotencyKey: r.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure },
      accepted: false,
      failure,
    },
  }
}

describe("instanceReloadHandle epoch ownership", () => {
  test("missing capability fails closed before any transport work", () => {
    const r = req()
    const peer = {
      isAvailable: () => true,
      hasCapability: () => false,
      privateInstanceReloadOutcomeWithHandle: () => {
        throw new Error("must not be called")
      },
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    expect(() => instanceReloadHandle({ peer: peer as never, live: true, epoch: 1, invalidate: () => {} }, r as never)).toThrow(
      "instance/reload capability",
    )
  })

  test("settled success/terminal preserved across post-response drift", async () => {
    for (const wire of [okWire(req()), terminalWire(req())]) {
      const r = req()
      const w =
        wire.kind === "valid" && (wire.result as { status: string }).status === "succeeded" ? okWire(r) : terminalWire(r)
      let epoch = 1
      const peer = {
        isAvailable: () => true,
        hasCapability: () => true,
        privateInstanceReloadOutcomeWithHandle: () => ({ id: 1, promise: Promise.resolve(w) }),
        tryCancelPending: () => true,
        invalidateOnObserverTimeout: () => {},
      }
      const deps = {
        peer: peer as never,
        live: true,
        get epoch() {
          return epoch
        },
        invalidate: () => {},
      }
      const handle = instanceReloadHandle(deps, r as never)
      epoch = 2
      const out = await handle.promise
      expect(out.kind).toBe("valid")
      if (out.kind === "valid") expect(out.result.status).not.toBe("ambiguous")
    }
  })

  test("unsettled retryable maps to ambiguous on drift", async () => {
    const r = req()
    const w = retryableWire(r)
    let epoch = 1
    const peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      privateInstanceReloadOutcomeWithHandle: () => ({ id: 2, promise: Promise.resolve(w) }),
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    const deps = {
      peer: peer as never,
      live: true,
      get epoch() {
        return epoch
      },
      invalidate: () => {},
    }
    const handle = instanceReloadHandle(deps, r as never)
    epoch = 2
    const out = await handle.promise
    expect(out.kind).toBe("valid")
    if (out.kind === "valid") expect(out.result.status).toBe("ambiguous")
  })
})
