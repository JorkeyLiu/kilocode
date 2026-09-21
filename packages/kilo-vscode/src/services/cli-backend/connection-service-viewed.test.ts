import { describe, expect, test } from "bun:test"
import { KiloConnectionService } from "./connection-service"

const uid = "11111111-1111-4111-8111-111111111111"

function serviceWith(client: { calls: unknown[] }) {
  const svc = new KiloConnectionService({} as never)
  ;(svc as unknown as { viewerId: string }).viewerId = uid
  ;(svc as unknown as { rootDirectory: string }).rootDirectory = "/tmp"
  ;(svc as unknown as { client: unknown }).client = {
    session: {
      viewed: async (body: unknown) => {
        client.calls.push(body)
      },
    },
  }
  return svc
}

function okPeer() {
  return {
    isAvailable: () => true,
    dispose: () => {},
    hasCapability: (cap: string) => cap === "session/viewed",
    privateSessionViewedOutcomeWithHandle: (r: { requestId: string }) => ({
      id: 1,
      promise: Promise.resolve({
        kind: "valid",
        result: {
          v: 1,
          requestId: r.requestId,
          op: "session/viewed",
          status: "succeeded",
          outcome: { type: "succeeded", time: 1 },
          accepted: true,
          data: { applied: true },
        },
      }),
      cancel: () => true,
    }),
    invalidateOnObserverTimeout: () => {},
    tryCancelPending: () => true,
    getState: () => "open",
  }
}

function terminalPeer() {
  const base = okPeer()
  return {
    ...base,
    privateSessionViewedOutcomeWithHandle: (r: { requestId: string }) => ({
      id: 2,
      promise: Promise.resolve({
        kind: "valid",
        result: {
          v: 1,
          requestId: r.requestId,
          op: "session/viewed",
          status: "failed",
          outcome: { type: "failed", time: 1, failure: { code: "validation.failed", message: "m", retryable: false } },
          accepted: false,
          failure: { code: "validation.failed", message: "m", retryable: false },
        },
      }),
      cancel: () => true,
    }),
  }
}

async function settle(svc: KiloConnectionService) {
  for (let i = 0; i < 50; i++) {
    const sending = (svc as unknown as { viewedSending: boolean }).viewedSending
    if (!sending) break
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("KiloConnectionService session/viewed private-first", () => {
  test("private success emits with zero SDK and monotonic sequence", async () => {
    const client = { calls: [] as unknown[] }
    const svc = serviceWith(client)
    ;(svc as unknown as { privatePeer: unknown }).privatePeer = okPeer()
    ;(svc as unknown as { privateAvailable: boolean }).privateAvailable = true
    ;(svc as unknown as { privateEpoch: number }).privateEpoch = 1
    svc.registerAttached("p1", ["ses_a"])
    svc.registerVisible("p1", ["ses_a"])
    // flush is debounced 150ms; drive the emission directly for determinism
    ;(svc as unknown as { sendViewed: () => void }).sendViewed()
    await settle(svc)
    expect(client.calls.length).toBe(0)
    expect((svc as unknown as { viewedSequence: number }).viewedSequence).toBe(1)
    ;(svc as unknown as { sendViewed: () => void }).sendViewed()
    await settle(svc)
    expect((svc as unknown as { viewedSequence: number }).viewedSequence).toBe(2)
    expect(client.calls.length).toBe(0)
    await svc.dispose()
  })

  test("terminal private failure closes with zero SDK", async () => {
    const client = { calls: [] as unknown[] }
    const svc = serviceWith(client)
    ;(svc as unknown as { privatePeer: unknown }).privatePeer = terminalPeer()
    ;(svc as unknown as { privateAvailable: boolean }).privateAvailable = true
    ;(svc as unknown as { privateEpoch: number }).privateEpoch = 1
    ;(svc as unknown as { sendViewed: () => void }).sendViewed()
    await settle(svc)
    expect(client.calls.length).toBe(0)
    await svc.dispose()
  })

  test("unavailable private takes exactly one same-snapshot SDK fallback", async () => {
    const client = { calls: [] as Array<{ viewer: { sequence: number }; attached: string[]; visible: string[] }> }
    const svc = serviceWith(client as never)
    svc.registerAttached("p1", ["ses_b"])
    svc.registerVisible("p1", ["ses_b"])
    ;(svc as unknown as { sendViewed: () => void }).sendViewed()
    await settle(svc)
    expect(client.calls.length).toBe(1)
    expect(client.calls[0]!.attached).toEqual(["ses_b"])
    expect(client.calls[0]!.visible).toEqual(["ses_b"])
    expect(typeof client.calls[0]!.viewer.sequence).toBe("number")
    await svc.dispose()
  })

  test("in-flight singleflight coalesces trailing emission with higher sequence", async () => {
    const client = { calls: [] as unknown[] }
    const svc = serviceWith(client)
    let release!: (v: unknown) => void
    const gate = new Promise((resolve) => { release = resolve })
    ;(svc as unknown as { privatePeer: unknown }).privatePeer = {
      isAvailable: () => true,
      dispose: () => {},
      hasCapability: () => true,
      privateSessionViewedOutcomeWithHandle: (r: { requestId: string }) => ({
        id: 5,
        promise: gate.then(() => ({
          kind: "valid",
          result: {
            v: 1,
            requestId: r.requestId,
            op: "session/viewed",
            status: "succeeded",
            outcome: { type: "succeeded", time: 1 },
            accepted: true,
            data: { applied: true },
          },
        })),
        cancel: () => true,
      }),
      invalidateOnObserverTimeout: () => {},
      tryCancelPending: () => true,
      getState: () => "open",
    }
    ;(svc as unknown as { privateAvailable: boolean }).privateAvailable = true
    ;(svc as unknown as { privateEpoch: number }).privateEpoch = 1
    ;(svc as unknown as { sendViewed: () => void }).sendViewed()
    expect((svc as unknown as { viewedSequence: number }).viewedSequence).toBe(1)
    ;(svc as unknown as { sendViewed: () => void }).sendViewed()
    expect((svc as unknown as { viewedDirty: boolean }).viewedDirty).toBe(true)
    expect((svc as unknown as { viewedSequence: number }).viewedSequence).toBe(1)
    release({})
    await settle(svc)
    await new Promise((r) => setTimeout(r, 20))
    await settle(svc)
    expect((svc as unknown as { viewedSequence: number }).viewedSequence).toBe(2)
    expect(client.calls.length).toBe(0)
    await svc.dispose()
  })

  test("dispose emits one final higher-sequence detach via private when available", async () => {
    const client = { calls: [] as unknown[] }
    const svc = serviceWith(client)
    let privateCalls = 0
    const peer = okPeer()
    const counting = {
      ...peer,
      privateSessionViewedOutcomeWithHandle: (r: { requestId: string }) => {
        privateCalls += 1
        return (peer.privateSessionViewedOutcomeWithHandle as (r: { requestId: string }) => never)(r) as never
      },
    }
    ;(svc as unknown as { privatePeer: unknown }).privatePeer = counting
    ;(svc as unknown as { privateAvailable: boolean }).privateAvailable = true
    ;(svc as unknown as { privateEpoch: number }).privateEpoch = 1
    ;(svc as unknown as { viewedSequence: number }).viewedSequence = 4
    await svc.dispose()
    expect(privateCalls).toBe(1)
    expect(client.calls.length).toBe(0)
    expect((svc as unknown as { viewedSequence: number }).viewedSequence).toBe(5)
  })

  test("dispose falls back to exactly one SDK detach when peer unavailable", async () => {
    const client = { calls: [] as Array<{ viewer: { active: boolean; sequence: number }; attached: string[] }> }
    const svc = serviceWith(client as never)
    ;(svc as unknown as { viewedSequence: number }).viewedSequence = 6
    await svc.dispose()
    expect(client.calls.length).toBe(1)
    expect(client.calls[0]!.viewer.active).toBe(false)
    expect(client.calls[0]!.viewer.sequence).toBe(7)
    expect(client.calls[0]!.attached).toEqual([])
  })

  test("dispose settles private detach before peer teardown", async () => {
    const client = { calls: [] as unknown[] }
    const svc = serviceWith(client)
    const order: string[] = []
    let release!: (v: unknown) => void
    const gate = new Promise((resolve) => { release = resolve })
    const inner = okPeer()
    let detachPayload: { viewer: { active: boolean; sequence: number }; attached: string[]; visible: string[] } | null = null
    const gated = {
      ...inner,
      privateSessionViewedOutcomeWithHandle: (r: { requestId: string; payload: { viewer: { active: boolean; sequence: number }; attached: string[]; visible: string[] } }) => ({
        id: 9,
        promise: gate.then(() => {
          detachPayload = r.payload
          order.push("detach-settled")
          return {
            kind: "valid",
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
        }),
        cancel: () => true,
      }),
      dispose: () => { order.push("peer-disposed") },
    }
    ;(svc as unknown as { privatePeer: unknown }).privatePeer = gated
    ;(svc as unknown as { privateAvailable: boolean }).privateAvailable = true
    ;(svc as unknown as { privateEpoch: number }).privateEpoch = 1
    ;(svc as unknown as { viewedSequence: number }).viewedSequence = 4
    const done = svc.dispose()
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual([])
    release({})
    await done
    expect(order).toEqual(["detach-settled", "peer-disposed"])
    expect(client.calls.length).toBe(0)
    expect((svc as unknown as { viewedSequence: number }).viewedSequence).toBe(5)
    expect(detachPayload!.viewer.active).toBe(false)
    expect(detachPayload!.viewer.sequence).toBe(5)
    expect(detachPayload!.attached).toEqual([])
    expect(detachPayload!.visible).toEqual([])
  })

  test("dispose private failure falls back to exactly one SDK detach before teardown", async () => {
    const client = { calls: [] as Array<{ viewer: { id: string; active: boolean; sequence: number }; attached: string[]; visible: string[] }> }
    const svc = serviceWith(client as never)
    const order: string[] = []
    const inner = okPeer()
    const failing = {
      ...inner,
      privateSessionViewedOutcomeWithHandle: () => ({ id: 10, promise: Promise.reject(new Error("boom")), cancel: () => true }),
      dispose: () => { order.push("peer-disposed") },
    }
    ;(svc as unknown as { privatePeer: unknown }).privatePeer = failing
    ;(svc as unknown as { privateAvailable: boolean }).privateAvailable = true
    ;(svc as unknown as { privateEpoch: number }).privateEpoch = 1
    ;(svc as unknown as { viewedSequence: number }).viewedSequence = 8
    const origViewed = (svc as unknown as { client: { session: { viewed: (b: unknown) => Promise<unknown> } } }).client.session.viewed
    ;(svc as unknown as { client: { session: { viewed: (b: unknown) => Promise<unknown> } } }).client.session.viewed = async (b: unknown) => {
      order.push("sdk-detach")
      return origViewed(b)
    }
    await svc.dispose()
    expect(order).toEqual(["sdk-detach", "peer-disposed"])
    expect(client.calls.length).toBe(1)
    expect(client.calls[0]!.viewer.active).toBe(false)
    expect(client.calls[0]!.viewer.sequence).toBe(9)
    expect(client.calls[0]!.attached).toEqual([])
    expect(client.calls[0]!.visible).toEqual([])
  })

  test("viewed in-flight dispose waits bounded detach, no trailing, no second peer/client touch, single sequence bump", async () => {
    const client = { calls: [] as unknown[] }
    const svc = serviceWith(client)
    let releaseViewed!: (v: unknown) => void
    const gateViewed = new Promise<unknown>((res) => { releaseViewed = res })
    let releaseDetach!: (v: unknown) => void
    const gateDetach = new Promise<unknown>((res) => { releaseDetach = res })
    const order: string[] = []
    let viewedCalls = 0
    let detachCalls = 0
    let detachPayload: { viewer: { active: boolean; sequence: number }; attached: string[]; visible: string[] } | null = null
    const peer = {
      isAvailable: () => true,
      dispose: () => { order.push("peer-disposed") },
      hasCapability: () => true,
      privateSessionViewedOutcomeWithHandle: (r: { requestId: string; payload: { viewer: { active: boolean; sequence: number }; attached: string[]; visible: string[] } }) => {
        if (viewedCalls === 0) {
          viewedCalls += 1
          return {
            id: 11,
            promise: gateViewed.then(() => {
              order.push("viewed-settled")
              return {
                kind: "valid",
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
            }),
            cancel: () => true,
          }
        }
        detachCalls += 1
        detachPayload = r.payload
        return {
          id: 12,
          promise: gateDetach.then(() => {
            order.push("detach-settled")
            return {
              kind: "valid",
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
          }),
          cancel: () => true,
        }
      },
      invalidateOnObserverTimeout: () => {},
      tryCancelPending: () => true,
      getState: () => "open",
    }
    ;(svc as unknown as { privatePeer: unknown }).privatePeer = peer
    ;(svc as unknown as { privateAvailable: boolean }).privateAvailable = true
    ;(svc as unknown as { privateEpoch: number }).privateEpoch = 1
    ;(svc as unknown as { viewedSequence: number }).viewedSequence = 0
    ;(svc as unknown as { sendViewed: () => void }).sendViewed()
    expect((svc as unknown as { viewedSending: boolean }).viewedSending).toBe(true)
    expect((svc as unknown as { viewedSequence: number }).viewedSequence).toBe(1)
    expect(viewedCalls).toBe(1)
    // mark dirty via second send while in-flight
    ;(svc as unknown as { sendViewed: () => void }).sendViewed()
    expect((svc as unknown as { viewedDirty: boolean }).viewedDirty).toBe(true)
    const disposeP = svc.dispose()
    await new Promise((r) => setTimeout(r, 20))
    // strictly bounded: detach must not have started while viewed in-flight
    expect(detachCalls).toBe(0)
    expect(order).toEqual([])
    // debounce/checkin cleared synchronously at dispose start
    expect((svc as unknown as { debounceTimer: unknown }).debounceTimer).toBe(null)
    // release viewed first
    releaseViewed({})
    // allow viewed settle then detach start
    await new Promise((r) => setTimeout(r, 30))
    expect(order).toEqual(["viewed-settled"])
    expect(viewedCalls).toBe(1)
    expect(detachCalls).toBe(1)
    expect(order.includes("detach-settled")).toBe(false)
    expect((svc as unknown as { viewedSequence: number }).viewedSequence).toBe(2)
    // no trailing viewed started; detach is via emitDisposeDetach, not viewedSending
    expect((svc as unknown as { viewedSending: boolean }).viewedSending).toBe(false)
    expect((svc as unknown as { viewedDirty: boolean }).viewedDirty).toBe(false)
    releaseDetach({})
    await disposeP
    expect(order).toEqual(["viewed-settled", "detach-settled", "peer-disposed"])
    expect(viewedCalls).toBe(1)
    expect(detachCalls).toBe(1)
    expect(client.calls.length).toBe(0)
    expect(detachPayload!.viewer.active).toBe(false)
    expect(detachPayload!.viewer.sequence).toBe(2)
    expect(detachPayload!.attached).toEqual([])
    expect(detachPayload!.visible).toEqual([])
    // sequence not extra bumped, no trailing
    expect((svc as unknown as { viewedSequence: number }).viewedSequence).toBe(2)
    expect((svc as unknown as { viewedSending: boolean }).viewedSending).toBe(false)
    expect((svc as unknown as { viewedDirty: boolean }).viewedDirty).toBe(false)
    // no timer left behind
    expect((svc as unknown as { debounceTimer: unknown }).debounceTimer).toBe(null)
    expect((svc as unknown as { checkinTimer: unknown }).checkinTimer).toBe(null)
    // extra settling must not create trailing viewed
    await new Promise((r) => setTimeout(r, 30))
    expect(viewedCalls).toBe(1)
    expect(detachCalls).toBe(1)
    expect(client.calls.length).toBe(0)
  })

  test("dispose idempotent concurrent and sequential: single detach and single peer/server disposal, no trailing timer", async () => {
    const client = { calls: [] as unknown[] }
    const svc = serviceWith(client)
    let release!: (v: unknown) => void
    const gate = new Promise<unknown>((res) => { release = res })
    const order: string[] = []
    let privateCalls = 0
    let peerDisposes = 0
    let serverDisposes = 0
    const peer = {
      isAvailable: () => true,
      dispose: () => { peerDisposes += 1; order.push("peer-disposed") },
      hasCapability: () => true,
      privateSessionViewedOutcomeWithHandle: (r: { requestId: string }) => {
        privateCalls += 1
        return {
          id: 13,
          promise: gate.then(() => {
            order.push("detach-settled")
            return {
              kind: "valid",
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
          }),
          cancel: () => true,
        }
      },
      invalidateOnObserverTimeout: () => {},
      tryCancelPending: () => true,
      getState: () => "open",
    }
    ;(svc as unknown as { privatePeer: unknown }).privatePeer = peer
    ;(svc as unknown as { privateAvailable: boolean }).privateAvailable = true
    ;(svc as unknown as { privateEpoch: number }).privateEpoch = 1
    ;(svc as unknown as { viewedSequence: number }).viewedSequence = 10
    const sm = (svc as unknown as { serverManager: { dispose: () => void } }).serverManager
    const origDispose = sm.dispose.bind(sm)
    ;(svc as unknown as { serverManager: { dispose: () => void } }).serverManager.dispose = () => { serverDisposes += 1; order.push("server-disposed") }
    // install observable timers
    ;(svc as unknown as { debounceTimer: unknown }).debounceTimer = setTimeout(() => {}, 10000)
    ;(svc as unknown as { checkinTimer: unknown }).checkinTimer = setInterval(() => {}, 10000)
    const p1 = svc.dispose()
    const p2 = svc.dispose()
    await new Promise((r) => setTimeout(r, 20))
    expect(privateCalls).toBe(1)
    expect(order).toEqual([])
    expect((svc as unknown as { debounceTimer: unknown }).debounceTimer).toBe(null)
    expect((svc as unknown as { checkinTimer: unknown }).checkinTimer).toBe(null)
    release({})
    await Promise.all([p1, p2])
    expect(privateCalls).toBe(1)
    expect(peerDisposes).toBe(1)
    expect(serverDisposes).toBe(1)
    expect(order).toEqual(["detach-settled", "peer-disposed", "server-disposed"])
    expect(client.calls.length).toBe(0)
    expect((svc as unknown as { viewedSequence: number }).viewedSequence).toBe(11)
    // sequential second dispose after settled must stay idempotent
    const p3 = svc.dispose()
    await p3
    expect(privateCalls).toBe(1)
    expect(peerDisposes).toBe(1)
    expect(serverDisposes).toBe(1)
    expect((svc as unknown as { viewedSequence: number }).viewedSequence).toBe(11)
    // no trailing after short delay
    await new Promise((r) => setTimeout(r, 30))
    expect(privateCalls).toBe(1)
    expect(client.calls.length).toBe(0)
    expect((svc as unknown as { debounceTimer: unknown }).debounceTimer).toBe(null)
    expect((svc as unknown as { checkinTimer: unknown }).checkinTimer).toBe(null)
    expect((svc as unknown as { viewedDirty: boolean }).viewedDirty).toBe(false)
    // restore to avoid leaking mocked serverManager for other tests (no further tests in file but keep clean)
    ;(svc as unknown as { serverManager: { dispose: () => void } }).serverManager.dispose = origDispose
    const dt = (svc as unknown as { debounceTimer: ReturnType<typeof setTimeout> | null }).debounceTimer
    if (dt) clearTimeout(dt)
    const ct = (svc as unknown as { checkinTimer: ReturnType<typeof setInterval> | null }).checkinTimer
    if (ct) clearInterval(ct)
  })
})
