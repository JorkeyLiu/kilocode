import { describe, expect, test } from "bun:test"
import { sessionViewedHandle } from "./serve-private-session-viewed-connection"
import { makeSessionViewedAmbiguous } from "./serve-private-session-viewed-contract"

const uid = "11111111-1111-4111-8111-111111111111"

function req() {
  return {
    v: 1 as const,
    requestId: "r-conn-1",
    op: "session/viewed" as const,
    context: { directory: "/tmp" },
    payload: { viewer: { id: uid, active: true, sequence: 1 }, attached: ["ses_a"], visible: ["ses_a"] },
  }
}

function okResult(r: { requestId: string }) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      op: "session/viewed",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { applied: true },
    },
  }
}

describe("session/viewed connection handle", () => {
  test("settled success survives post-response epoch drift", async () => {
    const r = req()
    const inner = { id: 1, promise: Promise.resolve(okResult(r)), cancel: () => true }
    const deps = { peer: null as never, live: true, epoch: 1, invalidate: () => {} }
    ;(deps as { peer: unknown }).peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      privateSessionViewedOutcomeWithHandle: () => inner,
      invalidateOnObserverTimeout: () => {},
      tryCancelPending: () => true,
    }
    const handle = sessionViewedHandle(deps, r as never)
    deps.epoch = 2
    const out = await handle.promise
    expect(out.kind).toBe("valid")
  })

  test("unresolved drift maps to ambiguous", async () => {
    const r = req()
    const ambiguous = { kind: "valid" as const, result: makeSessionViewedAmbiguous(r as never, true) }
    const inner = { id: 2, promise: Promise.resolve(ambiguous), cancel: () => true }
    const deps = { peer: null as never, live: true, epoch: 1, invalidate: () => {} }
    ;(deps as { peer: unknown }).peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      privateSessionViewedOutcomeWithHandle: () => inner,
      invalidateOnObserverTimeout: () => {},
      tryCancelPending: () => true,
    }
    const handle = sessionViewedHandle(deps, r as never)
    deps.epoch = 2
    const out = await handle.promise
    if (out.kind === "valid") expect(out.result.status).toBe("ambiguous")
    else throw new Error("expected valid")
  })

  test("exact cancel invalidates only on current-epoch miss", () => {
    const r = req()
    const inner = { id: 3, promise: Promise.resolve(okResult(r)), cancel: () => true }
    let invalidated = ""
    const fake = {
      isAvailable: () => true,
      hasCapability: () => true,
      privateSessionViewedOutcomeWithHandle: () => inner,
      invalidateOnObserverTimeout: () => {},
      tryCancelPending: () => false,
    }
    const deps = { peer: fake as never, live: true, epoch: 1, invalidate: (reason: string) => { invalidated = reason } }
    const handle = sessionViewedHandle(deps, r as never)
    expect(handle.cancel("timeout")).toBe(false)
    expect(invalidated).toContain("exact cancel miss")
  })
})
