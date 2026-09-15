import { describe, expect, test } from "bun:test"
import {
  buildSessionViewedReq,
  freezeSnapshot,
  parseSessionViewedResult,
  sendViewedPrivateFirst,
} from "./session-viewed-privatefirst"

const uid = "11111111-1111-4111-8111-111111111111"

function snap(sequence = 7) {
  return freezeSnapshot({ viewer: { id: uid, active: true, sequence }, attached: ["ses_a"], visible: ["ses_a"] })
}

function okWire(r: { requestId: string }) {
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

function terminalWire(r: { requestId: string }) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      op: "session/viewed",
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "validation.failed", message: "m", retryable: false } },
      accepted: false,
      failure: { code: "validation.failed", message: "m", retryable: false },
    },
  }
}

function retryableWire(r: { requestId: string }) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      op: "session/viewed",
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "x", message: "m", retryable: true } },
      accepted: false,
      failure: { code: "x", message: "m", retryable: true },
    },
  }
}

function ambiguousWire(r: { requestId: string }) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      op: "session/viewed",
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
    },
  }
}

describe("session/viewed private-first", () => {
  test("valid private success is authoritative with zero SDK", async () => {
    const seen: unknown[] = []
    const conn = {
      isPrivateAvailable: () => true,
      getPrivatePeer: () => ({}) as never,
      getPrivateEpoch: () => 1,
      invalidatePrivatePeerOnObserverTimeout: () => {},
      privateSessionViewedOutcomeWithHandle: (r: { requestId: string }) => ({
        id: 1,
        promise: Promise.resolve(okWire(r)),
        cancel: () => true,
      }),
    }
    const client = { session: { viewed: async (body: unknown) => { seen.push(body) } } }
    const out = await sendViewedPrivateFirst({ connection: conn as never, client: client as never, directory: "/tmp", snap: snap(3) })
    expect(out).toEqual({ kind: "ok", via: "private" })
    expect(seen.length).toBe(0)
  })

  test("validated terminal closes with zero SDK", async () => {
    const seen: unknown[] = []
    const conn = {
      isPrivateAvailable: () => true,
      getPrivatePeer: () => ({}) as never,
      getPrivateEpoch: () => 1,
      invalidatePrivatePeerOnObserverTimeout: () => {},
      privateSessionViewedOutcomeWithHandle: (r: { requestId: string }) => ({
        id: 2,
        promise: Promise.resolve(terminalWire(r)),
        cancel: () => true,
      }),
    }
    const client = { session: { viewed: async (body: unknown) => { seen.push(body) } } }
    const out = await sendViewedPrivateFirst({ connection: conn as never, client: client as never, directory: "/tmp", snap: snap(4) })
    expect(out.kind).toBe("terminal")
    expect(seen.length).toBe(0)
  })

  test("timeout takes exactly one same-snapshot SDK fallback", async () => {
    const seen: Array<{ viewer: { id: string; active: boolean; sequence: number }; attached: string[]; visible: string[] }> = []
    const conn = {
      isPrivateAvailable: () => true,
      getPrivatePeer: () => ({}) as never,
      getPrivateEpoch: () => 1,
      invalidatePrivatePeerOnObserverTimeout: () => {},
      privateSessionViewedOutcomeWithHandle: () => ({
        id: 3,
        promise: new Promise(() => {}),
        cancel: () => true,
      }),
    }
    const client = { session: { viewed: async (body: never) => { seen.push(body) } } }
    const source = snap(9)
    const out = await sendViewedPrivateFirst({ connection: conn as never, client: client as never, directory: "/tmp", snap: source })
    expect(out).toEqual({ kind: "ok", via: "sdk" })
    expect(seen.length).toBe(1)
    expect(seen[0]!.viewer).toEqual(source.viewer)
    expect(seen[0]!.attached).toEqual([...source.attached])
    expect(seen[0]!.visible).toEqual([...source.visible])
  })

  test("ambiguous/invalid/unavailable/retryable each take exactly one same-snapshot fallback, no retry", async () => {
    for (const wire of ["ambiguous", "invalid", "retryable"] as const) {
      const seen: unknown[] = []
      const conn = {
        isPrivateAvailable: () => true,
        getPrivatePeer: () => ({}) as never,
        getPrivateEpoch: () => 1,
        invalidatePrivatePeerOnObserverTimeout: () => {},
        privateSessionViewedOutcomeWithHandle: (r: { requestId: string }) => ({
          id: 4,
          promise: Promise.resolve(
            wire === "ambiguous" ? ambiguousWire(r) : wire === "invalid" ? { kind: "invalid", detail: "bad" } : retryableWire(r),
          ),
          cancel: () => true,
        }),
      }
      const client = { session: { viewed: async (body: unknown) => { seen.push(body) } } }
      const source = snap(11)
      const out = await sendViewedPrivateFirst({ connection: conn as never, client: client as never, directory: "/tmp", snap: source })
      expect(out).toEqual({ kind: "ok", via: "sdk" })
      expect(seen.length).toBe(1)
    }
    const seen: unknown[] = []
    const client = { session: { viewed: async (body: unknown) => { seen.push(body) } } }
    const out = await sendViewedPrivateFirst({ connection: null, client: client as never, directory: "/tmp", snap: snap(12) })
    expect(out).toEqual({ kind: "ok", via: "sdk" })
    expect(seen.length).toBe(1)
  })

  test("capability-missing maps to transport fallback with one SDK call", async () => {
    const seen: unknown[] = []
    const conn = {
      isPrivateAvailable: () => { throw new Error("Private peer missing session/viewed capability") },
    }
    const client = { session: { viewed: async (body: unknown) => { seen.push(body) } } }
    const out = await sendViewedPrivateFirst({ connection: conn as never, client: client as never, directory: "/tmp", snap: snap(13) })
    expect(out).toEqual({ kind: "ok", via: "sdk" })
    expect(seen.length).toBe(1)
  })

  test("private and fallback reuse the exact same immutable snapshot bytes", () => {
    const source = snap(21)
    const r = buildSessionViewedReq("/tmp", source)
    expect(r.payload.viewer).toEqual(source.viewer)
    expect(r.payload.attached).toEqual([...source.attached])
    expect(r.payload.visible).toEqual([...source.visible])
    expect(Object.isFrozen(source.attached)).toBe(true)
    expect(Object.isFrozen(source.visible)).toBe(true)
    expect(parseSessionViewedResult({ status: "ambiguous" }, r).kind).toBe("fallback")
  })

  test("generic peer rejection takes one private plus exactly one identical-snapshot SDK fallback", async () => {
    let privateCalls = 0
    const seen: Array<{ viewer: { id: string; active: boolean; sequence: number }; attached: string[]; visible: string[] }> = []
    const conn = {
      isPrivateAvailable: () => true,
      getPrivatePeer: () => ({}) as never,
      getPrivateEpoch: () => 1,
      invalidatePrivatePeerOnObserverTimeout: () => {},
      privateSessionViewedOutcomeWithHandle: () => {
        privateCalls += 1
        return { id: 5, promise: Promise.reject(new Error("boom")), cancel: () => true }
      },
    }
    const client = { session: { viewed: async (body: never) => { seen.push(body) } } }
    const source = freezeSnapshot({ viewer: { id: uid, active: false, sequence: 17 }, attached: ["ses_b", "ses_a"], visible: ["ses_a", "ses_b"] })
    const out = await sendViewedPrivateFirst({ connection: conn as never, client: client as never, directory: "/tmp", snap: source })
    expect(out).toEqual({ kind: "ok", via: "sdk" })
    expect(privateCalls).toBe(1)
    expect(seen.length).toBe(1)
    expect(seen[0]!.viewer.id).toBe(source.viewer.id)
    expect(seen[0]!.viewer.sequence).toBe(source.viewer.sequence)
    expect(seen[0]!.viewer.active).toBe(source.viewer.active)
    expect(seen[0]!.attached).toEqual([...source.attached])
    expect(seen[0]!.visible).toEqual([...source.visible])
  })

  test("malformed failed with accepted:true is invalid and takes exactly one SDK fallback", async () => {
    let privateCalls = 0
    const seen: unknown[] = []
    const conn = {
      isPrivateAvailable: () => true,
      getPrivatePeer: () => ({}) as never,
      getPrivateEpoch: () => 1,
      invalidatePrivatePeerOnObserverTimeout: () => {},
      privateSessionViewedOutcomeWithHandle: (r: { requestId: string }) => {
        privateCalls += 1
        return {
          id: 6,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: r.requestId,
              op: "session/viewed",
              status: "failed",
              outcome: { type: "failed", time: 1, failure: { code: "validation.failed", message: "m", retryable: false } },
              accepted: true,
              failure: { code: "validation.failed", message: "m", retryable: false },
            },
          }),
          cancel: () => true,
        }
      },
    }
    const client = { session: { viewed: async (body: unknown) => { seen.push(body) } } }
    const out = await sendViewedPrivateFirst({ connection: conn as never, client: client as never, directory: "/tmp", snap: snap(19) })
    expect(out).toEqual({ kind: "ok", via: "sdk" })
    expect(privateCalls).toBe(1)
    expect(seen.length).toBe(1)
  })
})
