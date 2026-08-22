import { describe, it, expect } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import {
  OBSERVATION_VERSION,
  OBSERVATION_METHODS,
  OBSERVATION_NOTIFICATION,
  ObservationController,
  createObservationHandler,
  type ObservationEntry,
  type ObservationReadBackendResult,
} from "../../src/private-worker/observation"

// In-memory changefeed mimic for protocol tests
function makeStore() {
  let seq = 0
  let latest = 0
  const entries: ObservationEntry[] = []
  const seen = new Map<string, ObservationEntry>()
  const acked = { cursor: 0 }

  function key(s: string, r: number, k: string) {
    return `${s}:${r}:${k}`
  }

  return {
    append(session_id: string, revision: number, kind: ObservationEntry["kind"], time: number): ObservationEntry {
      const k = key(session_id, revision, kind)
      const existing = seen.get(k)
      if (existing) return existing
      seq += 1
      latest = seq
      const e: ObservationEntry = { seq, session_id, revision, kind: kind as ObservationEntry["kind"], time }
      entries.push(e)
      seen.set(k, e)
      return e
    },
    getEntries() {
      return [...entries]
    },
    getLatest() {
      return latest
    },
    _rawEntries() {
      return entries
    },
    _setEntries(next: ObservationEntry[]) {
      entries.length = 0
      entries.push(...next)
      if (next.length === 0) {
        // keep latest as is
      } else {
        latest = Math.max(latest, Math.max(...next.map((e) => e.seq)))
      }
    },
    deleteSeq(target: number) {
      const idx = entries.findIndex((e) => e.seq === target)
      if (idx >= 0) entries.splice(idx, 1)
    },
    deps(): {
      getSnapshot: () => Promise<{ cursor: number; snapshot: unknown }>
      readAfter: (cursor: number) => Promise<ObservationReadBackendResult>
      ack: (cursor: number) => Promise<void>
    } {
      const self = this
      return {
        getSnapshot: async () => ({ cursor: latest, snapshot: { entries: [...entries] } }),
        readAfter: async (cursor: number) => {
          if (cursor < 0 || !Number.isInteger(cursor)) return { type: "rehydrate", cursor: latest, reason: "invalid cursor" }
          if (cursor > latest) return { type: "rehydrate", cursor: latest, reason: "cursor ahead" }
          if (entries.length === 0) {
            if (cursor === latest) return { type: "deltas", cursor: latest, entries: [] }
            return { type: "rehydrate", cursor: latest, reason: "truncated" }
          }
          const minSeq = entries[0]!.seq
          if (cursor + 1 < minSeq) return { type: "rehydrate", cursor: latest, reason: "evicted" }
          const filtered = entries.filter((e) => e.seq > cursor)
          if (filtered.length > 0) {
            let exp = cursor + 1
            for (const e of filtered) {
              if (e.seq !== exp) return { type: "rehydrate", cursor: latest, reason: "gap" }
              exp += 1
            }
          }
          if (cursor < latest) {
            if (filtered.length === 0) return { type: "rehydrate", cursor: latest, reason: "gap" }
            const last = filtered[filtered.length - 1]!.seq
            if (last !== latest) return { type: "rehydrate", cursor: latest, reason: "gap" }
            if (filtered.length !== latest - cursor) return { type: "rehydrate", cursor: latest, reason: "gap" }
          }
          return { type: "deltas", cursor: latest, entries: filtered }
        },
        ack: async (cursor: number) => {
          if (cursor > latest) {
            const err = new Error(`ack cursor ${cursor} ahead of latest ${latest}`) as Error & { code?: number }
            err.code = ErrorCode.InvalidParams
            throw err
          }
          // truncate <=cursor
          const remaining = entries.filter((e) => e.seq > cursor)
          entries.length = 0
          entries.push(...remaining)
        },
      }
    },
  }
}

function makePair(deps: ReturnType<ReturnType<typeof makeStore>["deps"]>) {
  const ctrl = new ObservationController(deps)
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
  const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
  return { client, server, ctrl, aToB, bToA }
}

describe("R9 observation wire foundation - versioned envelope", () => {
  it("snapshot/read/ack/subscribe return versioned envelope v=1.0", async () => {
    const store = makeStore()
    const pair = makePair(store.deps())
    const snap = (await pair.client.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
    expect(snap.v).toBe(OBSERVATION_VERSION)
    const read = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { v: string }
    expect(read.v).toBe(OBSERVATION_VERSION)
    const ack = (await pair.client.request(OBSERVATION_METHODS.ACK, { cursor: 0 })) as { v: string }
    expect(ack.v).toBe(OBSERVATION_VERSION)
    const sub = (await pair.client.request(OBSERVATION_METHODS.SUBSCRIBE, {})) as { v: string }
    expect(sub.v).toBe(OBSERVATION_VERSION)
    pair.client.dispose()
    pair.server.dispose()
  })

  it("unsupported version returns InvalidParams", async () => {
    const store = makeStore()
    const pair = makePair(store.deps())
    try {
      await pair.client.request(OBSERVATION_METHODS.SNAPSHOT, { v: "9.9" })
      expect(false).toBe(true)
    } catch (e) {
      expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
    }
    try {
      await pair.client.request(OBSERVATION_METHODS.READ, { v: "9.9", cursor: 0 })
      expect(false).toBe(true)
    } catch (e) {
      expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
    }
    pair.client.dispose()
    pair.server.dispose()
  })

  it("explicit method names are correct and notification name is observation/changed", async () => {
    expect(OBSERVATION_METHODS.SNAPSHOT).toBe("observation/snapshot")
    expect(OBSERVATION_METHODS.READ).toBe("observation/read")
    expect(OBSERVATION_METHODS.ACK).toBe("observation/ack")
    expect(OBSERVATION_METHODS.SUBSCRIBE).toBe("observation/subscribe")
    expect(OBSERVATION_NOTIFICATION).toBe("observation/changed")
  })
})

describe("R9 snapshot cursor establishment", () => {
  it("snapshot establishes cursor and read after cursor returns deltas", async () => {
    const store = makeStore()
    const e1 = store.append("ses_a", 1, "changed", 100)
    const e2 = store.append("ses_b", 1, "changed", 101)
    const pair = makePair(store.deps())
    const snap = (await pair.client.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number; snapshot: unknown }
    expect(snap.cursor).toBe(e2.seq)
    const read0 = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean; entries: ObservationEntry[]; cursor: number }
    expect(read0.rehydrate).toBe(false)
    expect(read0.entries.length).toBe(2)
    expect(read0.entries[0]!.seq).toBe(e1.seq)
    const readAfterSnap = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: snap.cursor })) as { rehydrate: boolean; entries: ObservationEntry[] }
    expect(readAfterSnap.rehydrate).toBe(false)
    expect(readAfterSnap.entries.length).toBe(0)
    // append after snapshot, read again delivers new entry
    store.append("ses_a", 2, "changed", 102)
    const after = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: snap.cursor })) as { entries: ObservationEntry[]; cursor: number; rehydrate: boolean }
    expect(after.rehydrate).toBe(false)
    expect(after.entries.length).toBe(1)
    expect(after.entries[0]!.session_id).toBe("ses_a")
    pair.client.dispose()
    pair.server.dispose()
  })

  it("entries are payload-free only seq/session_id/revision/kind/time", async () => {
    const store = makeStore()
    store.append("ses_x", 5, "deleted", 999)
    const pair = makePair(store.deps())
    const res = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { entries: ObservationEntry[] }
    expect(res.entries.length).toBe(1)
    const keys = Object.keys(res.entries[0]!).sort()
    expect(keys).toEqual(["kind", "revision", "seq", "session_id", "time"])
    pair.client.dispose()
    pair.server.dispose()
  })
})

describe("R9 contiguous read", () => {
  it("contiguous reads return deltas without rehydrate", async () => {
    const store = makeStore()
    const a = store.append("ses_1", 1, "changed", 1)
    const b = store.append("ses_2", 1, "changed", 2)
    const c = store.append("ses_1", 2, "changed", 3)
    const pair = makePair(store.deps())
    const r0 = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean; entries: ObservationEntry[]; cursor: number }
    expect(r0.rehydrate).toBe(false)
    expect(r0.entries.map((e) => e.seq)).toEqual([a.seq, b.seq, c.seq])
    expect(r0.cursor).toBe(c.seq)
    const r1 = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: a.seq })) as { entries: ObservationEntry[]; rehydrate: boolean }
    expect(r1.rehydrate).toBe(false)
    expect(r1.entries.map((e) => e.seq)).toEqual([b.seq, c.seq])
    // duplicate delivery idempotent: same cursor yields same entries
    const r1dup = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: a.seq })) as { entries: ObservationEntry[] }
    expect(r1dup.entries.map((e) => e.seq)).toEqual([b.seq, c.seq])
    pair.client.dispose()
    pair.server.dispose()
  })
})

describe("R9 gap->rehydrate", () => {
  it("stale/evicted cursor produces rehydrate, never fabricated deltas", async () => {
    const store = makeStore()
    const e1 = store.append("ses_g1", 1, "changed", 1)
    const e2 = store.append("ses_g2", 1, "changed", 2)
    const e3 = store.append("ses_g3", 1, "changed", 3)
    const pair = makePair(store.deps())
    // simulate eviction by truncating oldest via ack
    await pair.client.request(OBSERVATION_METHODS.ACK, { cursor: e1.seq })
    // now e1 evicted, reading with cursor 0 should be behind minSeq
    const gap = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean; reason: string; cursor: number; entries: ObservationEntry[] }
    expect(gap.rehydrate).toBe(true)
    expect(gap.entries.length).toBe(0)
    expect(typeof gap.reason).toBe("string")
    expect(gap.cursor).toBe(e3.seq)
    // contiguous cursor at e1 (evicted boundary) still delivers e2,e3
    const contiguous = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: e1.seq })) as { rehydrate: boolean; entries: ObservationEntry[] }
    expect(contiguous.rehydrate).toBe(false)
    expect(contiguous.entries.length).toBe(2)
    pair.client.dispose()
    pair.server.dispose()
  })

  it("interior gap from missing seq forces rehydrate", async () => {
    const store = makeStore()
    const e1 = store.append("ses_i1", 1, "changed", 1)
    const e2 = store.append("ses_i2", 1, "changed", 2)
    const e3 = store.append("ses_i3", 1, "changed", 3)
    // create interior gap by deleting middle
    store.deleteSeq(e2.seq)
    const pair = makePair(store.deps())
    const res = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: e1.seq - 1 >= 0 ? e1.seq - 1 : 0 })) as { rehydrate: boolean }
    // reading from before gap should detect gap
    const from0 = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean }
    expect(from0.rehydrate).toBe(true)
    const afterE1 = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: e1.seq })) as { rehydrate: boolean }
    expect(afterE1.rehydrate).toBe(true)
    pair.client.dispose()
    pair.server.dispose()
  })

  it("cursor ahead returns rehydrate", async () => {
    const store = makeStore()
    store.append("ses_cur", 1, "changed", 1)
    const pair = makePair(store.deps())
    const snap = (await pair.client.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number }
    const ahead = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: snap.cursor + 10 })) as { rehydrate: boolean; cursor: number }
    expect(ahead.rehydrate).toBe(true)
    expect(ahead.cursor).toBe(snap.cursor)
    pair.client.dispose()
    pair.server.dispose()
  })
})

describe("R9 ack validation/delegation", () => {
  it("valid ack delegates to backend and truncates", async () => {
    let delegated = -1
    const store = makeStore()
    const e1 = store.append("ses_ack1", 1, "changed", 1)
    const e2 = store.append("ses_ack2", 1, "changed", 2)
    const deps = store.deps()
    const origAck = deps.ack
    deps.ack = async (c: number) => {
      delegated = c
      return origAck(c)
    }
    const pair = makePair(deps)
    const ackRes = (await pair.client.request(OBSERVATION_METHODS.ACK, { cursor: e1.seq })) as { cursor: number; v: string }
    expect(delegated).toBe(e1.seq)
    expect(ackRes.v).toBe(OBSERVATION_VERSION)
    // after ack, read with cursor before eviction should rehydrate, but cursor at acked point is contiguous
    const after = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: e1.seq })) as { rehydrate: boolean; entries: ObservationEntry[] }
    expect(after.rehydrate).toBe(false)
    expect(after.entries.length).toBe(1)
    expect(after.entries[0]!.seq).toBe(e2.seq)
    pair.client.dispose()
    pair.server.dispose()
  })

  it("ack with malformed cursor returns InvalidParams", async () => {
    const store = makeStore()
    store.append("ses_bad", 1, "changed", 1)
    const pair = makePair(store.deps())
    const badCases: unknown[] = [
      { cursor: "1" },
      { cursor: 1.5 },
      { cursor: -1 },
      {},
      { cursor: null },
      null,
      "string",
    ]
    for (const params of badCases) {
      try {
        await pair.client.request(OBSERVATION_METHODS.ACK, params)
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
    }
    // ack ahead should also be InvalidParams (delegated)
    const snap = (await pair.client.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number }
    try {
      await pair.client.request(OBSERVATION_METHODS.ACK, { cursor: snap.cursor + 100 })
      expect(false).toBe(true)
    } catch (e) {
      expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
    }
    pair.client.dispose()
    pair.server.dispose()
  })
})

describe("R9 subscribe/notification payload shape", () => {
  it("subscribe returns subscribed true with versioned cursor and notification is versioned", async () => {
    const store = makeStore()
    store.append("ses_sub", 1, "changed", 1)
    const pair = makePair(store.deps())
    const sub = (await pair.client.request(OBSERVATION_METHODS.SUBSCRIBE, {})) as { v: string; cursor: number; subscribed: boolean }
    expect(sub.v).toBe(OBSERVATION_VERSION)
    expect(sub.subscribed).toBe(true)
    expect(typeof sub.cursor).toBe("number")

    // notification delivery via controller
    const received: unknown[] = []
    const aToB2 = new PassThrough()
    const bToA2 = new PassThrough()
    const ctrl = new ObservationController(store.deps())
    const server2 = new JsonRpcPeer({ reader: aToB2, writer: bToA2, onRequest: (m, p) => ctrl.handle(m, p) })
    const client2 = new JsonRpcPeer({ reader: bToA2, writer: aToB2, onNotification: (method, params) => received.push({ method, params }) })
    // wait for peers to be ready (no handshake needed)
    await new Promise((r) => setTimeout(r, 10))
    const e1 = store.append("ses_notify", 2, "changed", 5)
    ctrl.notifyChanged(server2, [e1], e1.seq)
    await new Promise((r) => setTimeout(r, 20))
    expect(received.length).toBe(1)
    const notif = received[0] as { method: string; params: { v: string; cursor: number; entries: ObservationEntry[] } }
    expect(notif.method).toBe(OBSERVATION_NOTIFICATION)
    expect(notif.params.v).toBe(OBSERVATION_VERSION)
    expect(notif.params.cursor).toBe(e1.seq)
    expect(notif.params.entries.length).toBe(1)
    expect(Object.keys(notif.params.entries[0]!).sort()).toEqual(["kind", "revision", "seq", "session_id", "time"])
    client2.dispose()
    server2.dispose()
    pair.client.dispose()
    pair.server.dispose()
  })

  it("subscribe with cursor validates", async () => {
    const store = makeStore()
    const pair = makePair(store.deps())
    try {
      await pair.client.request(OBSERVATION_METHODS.SUBSCRIBE, { cursor: "bad" })
      expect(false).toBe(true)
    } catch (e) {
      expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
    }
    pair.client.dispose()
    pair.server.dispose()
  })
})

describe("R9 malformed params", () => {
  it("read without cursor and with invalid cursor returns InvalidParams", async () => {
    const store = makeStore()
    store.append("ses_mal", 1, "changed", 1)
    const pair = makePair(store.deps())
    const cases: unknown[] = [{}, { cursor: "x" }, { cursor: 1.2 }, { cursor: -5 }, { cursor: null }, null, 123]
    for (const params of cases) {
      try {
        await pair.client.request(OBSERVATION_METHODS.READ, params)
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
    }
    pair.client.dispose()
    pair.server.dispose()
  })

  it("unknown observation method returns MethodNotFound", async () => {
    const store = makeStore()
    const pair = makePair(store.deps())
    try {
      await pair.client.request("observation/unknown", {})
      expect(false).toBe(true)
    } catch (e) {
      expect((e as { code?: number }).code).toBe(ErrorCode.MethodNotFound)
    }
    pair.client.dispose()
    pair.server.dispose()
  })
})

describe("R9 closed kind validation", () => {
  it("read rejects invalid kind with InvalidParams before response", async () => {
    const store = makeStore()
    store.append("ses_ok", 1, "changed", 1)
    const deps = store.deps()
    deps.readAfter = async () => ({
      type: "deltas",
      cursor: 1,
      entries: [{ seq: 1, session_id: "ses_ok", revision: 1, kind: "bogus" as unknown as ObservationEntry["kind"], time: 1 }],
    })
    const pair = makePair(deps)
    try {
      await pair.client.request(OBSERVATION_METHODS.READ, { cursor: 0 })
      expect(false).toBe(true)
    } catch (e) {
      expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
    }
    pair.client.dispose()
    pair.server.dispose()
  })

  it("notifyChanged rejects invalid kind with InvalidParams before notification", async () => {
    const store = makeStore()
    const ctrl = new ObservationController(store.deps())
    const aToB = new PassThrough()
    const bToA = new PassThrough()
    const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
    const bad: ObservationEntry = { seq: 99, session_id: "ses_bad", revision: 1, kind: "oops" as unknown as ObservationEntry["kind"], time: 1 }
    expect(() => ctrl.notifyChanged(server, [bad], 99)).toThrow()
    try {
      ctrl.notifyChanged(server, [bad], 99)
      expect(false).toBe(true)
    } catch (e) {
      expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
    }
    server.dispose()
    aToB.end()
    bToA.end()
  })

  it("deleted kind is accepted", async () => {
    const store = makeStore()
    store.append("ses_del", 1, "deleted", 1)
    const pair = makePair(store.deps())
    const res = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { entries: ObservationEntry[]; rehydrate: boolean }
    expect(res.rehydrate).toBe(false)
    expect(res.entries[0]!.kind).toBe("deleted")
    pair.client.dispose()
    pair.server.dispose()
  })
})

describe("R9 explicit undefined cursor", () => {
  it("subscribe with explicit cursor undefined is InvalidParams, omitted remains valid", async () => {
    const store = makeStore()
    const pair = makePair(store.deps())
    const ctrl = new ObservationController(store.deps())
    const ok = (await pair.client.request(OBSERVATION_METHODS.SUBSCRIBE, {})) as { subscribed: boolean }
    expect(ok.subscribed).toBe(true)
    const ok2 = (await pair.client.request(OBSERVATION_METHODS.SUBSCRIBE, { v: OBSERVATION_VERSION })) as { subscribed: boolean }
    expect(ok2.subscribed).toBe(true)
    for (const params of [{ cursor: undefined }, { cursor: undefined, v: OBSERVATION_VERSION }]) {
      try {
        await ctrl.handle(OBSERVATION_METHODS.SUBSCRIBE, params)
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
    }
    const ok3 = (await pair.client.request(OBSERVATION_METHODS.SUBSCRIBE, {})) as { subscribed: boolean }
    expect(ok3.subscribed).toBe(true)
    pair.client.dispose()
    pair.server.dispose()
  })
})

describe("R9 no impact to existing EOF/pending", () => {
  it("createObservationHandler is reachable (knip) and cursor idempotent", async () => {
    const store = makeStore()
    const h = createObservationHandler(store.deps())
    const res = (await h(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string }
    expect(res.v).toBe(OBSERVATION_VERSION)
  })

  it("pending request rejected on EOF unchanged with observation peer", async () => {
    const store = makeStore()
    const aToB = new PassThrough()
    const bToA = new PassThrough()
    const ctrl = new ObservationController(store.deps())
    const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
    const server = new JsonRpcPeer({
      reader: aToB,
      writer: bToA,
      onRequest: async (method, params) => {
        if (method.startsWith("observation/")) return ctrl.handle(method, params)
        // never respond to keep pending
        await new Promise(() => {})
        return "never"
      },
    })
    const pending = client.request("slow")
    pending.catch(() => {})
    aToB.end()
    bToA.end()
    await new Promise((r) => setTimeout(r, 20))
    expect(client.getState()).toBe("closed")
    expect(server.getState()).toBe("closed")
    try {
      await pending
      expect(false).toBe(true)
    } catch (e) {
      expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
    }
    try {
      await client.request(OBSERVATION_METHODS.SNAPSHOT, {})
      expect(false).toBe(true)
    } catch (e) {
      expect((e as Error).message).toContain("closed")
    }
  })

  it("duplicate read is idempotent via cursor/seq", async () => {
    const store = makeStore()
    const e1 = store.append("ses_dup", 1, "changed", 1)
    const e2 = store.append("ses_dup", 2, "changed", 2)
    const pair = makePair(store.deps())
    const first = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { entries: ObservationEntry[]; cursor: number }
    const second = (await pair.client.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { entries: ObservationEntry[]; cursor: number }
    expect(first.entries).toEqual(second.entries)
    expect(first.cursor).toBe(second.cursor)
    expect(first.entries.map((e) => e.seq)).toEqual([e1.seq, e2.seq])
    pair.client.dispose()
    pair.server.dispose()
  })
})

