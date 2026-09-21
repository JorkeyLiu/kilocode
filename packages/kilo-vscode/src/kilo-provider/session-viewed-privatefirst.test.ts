import { describe, expect, test } from "bun:test"
import {
  buildSessionViewedReq,
  collectViewedSnapshot,
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

describe("collectViewedSnapshot", () => {
  function m(entries: Array<[string, string[]]>): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>()
    for (const [k, v] of entries) out.set(k, new Set(v))
    return out
  }

  test("union dedups and keeps deterministic insertion order, visible ⊆ attached", () => {
    const attached = m([
      ["pA", ["ses_a", "ses_b"]],
      ["pB", ["ses_b", "ses_d"]],
    ])
    const visible = m([
      ["pA", ["ses_a", "ses_b"]],
      ["pB", ["ses_b", "ses_c"]],
    ])
    const snapRes = collectViewedSnapshot(uid, true, 42, attached, visible)
    expect(snapRes.viewer).toEqual({ id: uid, active: true, sequence: 42 })
    // visible = provider iteration order, deduped
    expect([...snapRes.visible]).toEqual(["ses_a", "ses_b", "ses_c"])
    // attached = visible insertion order first, then attached-only in provider order
    expect([...snapRes.attached]).toEqual(["ses_a", "ses_b", "ses_c", "ses_d"])
    for (const id of snapRes.visible) expect(snapRes.attached.includes(id)).toBe(true)
  })

  test("visible-only ids are included in attached even if not in attached map", () => {
    const attached = m([["pA", ["ses_x"]]])
    const visible = m([["pA", ["ses_y"]]])
    const s = collectViewedSnapshot(uid, true, 1, attached, visible)
    expect([...s.visible]).toEqual(["ses_y"])
    expect([...s.attached]).toEqual(["ses_y", "ses_x"])
    expect(s.attached.includes("ses_y")).toBe(true)
  })

  test("duplicate ids across providers and within same set are deduped without sorting", () => {
    const attached = m([
      ["pA", ["ses_2", "ses_1", "ses_2"]],
      ["pB", ["ses_1", "ses_3"]],
    ])
    const visible = m([
      ["pA", ["ses_2", "ses_1"]],
      ["pB", ["ses_1", "ses_2", "ses_3"]],
    ])
    const s = collectViewedSnapshot(uid, false, 5, attached, visible)
    expect([...s.visible]).toEqual(["ses_2", "ses_1", "ses_3"])
    expect([...s.attached]).toEqual(["ses_2", "ses_1", "ses_3"])
  })

  test("visible empty but attached non-empty", () => {
    const attached = m([
      ["pA", ["ses_a"]],
      ["pB", ["ses_b"]],
    ])
    const visible = m([])
    const s = collectViewedSnapshot(uid, true, 10, attached, visible)
    expect([...s.visible]).toEqual([])
    expect([...s.attached]).toEqual(["ses_a", "ses_b"])
  })

  test("visible non-empty but attached empty still yields attached == visible", () => {
    const attached = m([])
    const visible = m([["pA", ["ses_q", "ses_r"]]])
    const s = collectViewedSnapshot(uid, true, 11, attached, visible)
    expect([...s.visible]).toEqual(["ses_q", "ses_r"])
    expect([...s.attached]).toEqual(["ses_q", "ses_r"])
  })

  test("both attached and visible empty", () => {
    const s = collectViewedSnapshot(uid, false, 0, m([]), m([]))
    expect([...s.visible]).toEqual([])
    expect([...s.attached]).toEqual([])
    expect(s.viewer).toEqual({ id: uid, active: false, sequence: 0 })
  })

  test("viewer id/active/sequence are copied exactly and deeply frozen", () => {
    for (const active of [true, false] as const) {
      const s = collectViewedSnapshot("viewer-x", active, 99, m([["p", ["ses_a"]]]), m([["p", ["ses_a"]]]))
      expect(s.viewer.id).toBe("viewer-x")
      expect(s.viewer.active).toBe(active)
      expect(s.viewer.sequence).toBe(99)
      expect(Object.isFrozen(s.viewer)).toBe(true)
    }
  })

  test("returned snapshot, viewer, attached, visible are frozen and resistant to mutation", () => {
    const attached = m([["pA", ["ses_a"]]])
    const visible = m([["pA", ["ses_a"]]])
    const s = collectViewedSnapshot(uid, true, 77, attached, visible)
    expect(Object.isFrozen(s.viewer)).toBe(true)
    expect(Object.isFrozen(s.attached)).toBe(true)
    expect(Object.isFrozen(s.visible)).toBe(true)
    const beforeAttached = [...s.attached]
    const beforeVisible = [...s.visible]
    const beforeViewer = { ...s.viewer }
    // attempt mutations without relying on throw message
    try {
      ;(s.attached as string[]).push("ses_evil")
    } catch {}
    try {
      ;(s.visible as string[]).push("ses_evil")
    } catch {}
    try {
      ;(s.viewer as { id: string }).id = "evil"
    } catch {}
    expect([...s.attached]).toEqual(beforeAttached)
    expect([...s.visible]).toEqual(beforeVisible)
    expect(s.viewer).toEqual(beforeViewer)
    expect(Object.isFrozen(s.attached)).toBe(true)
    expect(Object.isFrozen(s.visible)).toBe(true)
    expect(Object.isFrozen(s.viewer)).toBe(true)
  })

  test("subsequent source map mutations do not affect frozen snapshot", () => {
    const attached = m([["pA", ["ses_a"]]])
    const visible = m([["pA", ["ses_a"]]])
    const s = collectViewedSnapshot(uid, true, 88, attached, visible)
    attached.get("pA")!.add("ses_b")
    visible.get("pA")!.add("ses_c")
    attached.set("pB", new Set(["ses_d"]))
    visible.set("pB", new Set(["ses_e"]))
    expect([...s.attached]).toEqual(["ses_a"])
    expect([...s.visible]).toEqual(["ses_a"])
  })

  test("provider insertion order is preserved, not sorted", () => {
    const attached = m([
      ["pB", ["ses_z"]],
      ["pA", ["ses_a"]],
    ])
    const visible = m([
      ["pB", ["ses_z"]],
      ["pA", ["ses_a"]],
    ])
    const s = collectViewedSnapshot(uid, true, 3, attached, visible)
    expect([...s.visible]).toEqual(["ses_z", "ses_a"])
    expect([...s.attached]).toEqual(["ses_z", "ses_a"])
    // reversed provider order yields reversed result, proving no sort
    const attached2 = m([
      ["pA", ["ses_a"]],
      ["pB", ["ses_z"]],
    ])
    const visible2 = m([
      ["pA", ["ses_a"]],
      ["pB", ["ses_z"]],
    ])
    const s2 = collectViewedSnapshot(uid, true, 3, attached2, visible2)
    expect([...s2.visible]).toEqual(["ses_a", "ses_z"])
    expect([...s2.attached]).toEqual(["ses_a", "ses_z"])
  })
})
