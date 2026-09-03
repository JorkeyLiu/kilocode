import { describe, expect, it } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import {
  ServePrivatePeer,
  buildStatusOpId,
  compareStatusParity,
  isPrivateStatusValidationError,
  normalizePrivateStatusWire,
  validateCancelQueuedResult,
  validateSessionUpdateResult,
  validateStatusRequest,
  validateStatusResult,
  type ServePrivateStatusRequest,
  type ServePrivateStatusResult,
} from "../../src/services/cli-backend/serve-private-peer"
import { seedSessionStatuses } from "../../src/session-status"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import type { SessionStatus } from "@kilocode/sdk/v2/client"

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`latch timeout: ${label}`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function noteCleanup(label: string, err: unknown): void {
  console.warn(`[cleanup:${label}] ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`)
}

function warnLatch(sub: string): { promise: Promise<string>; onWarn: (msg: string) => void } {
  const gate = deferred<string>()
  return {
    promise: withDeadline(gate.promise, 2000, `warn latch: ${sub}`),
    onWarn: (msg: string) => {
      if (msg.includes(sub)) gate.resolve(msg)
    },
  }
}

function req(dir = "/repo", overrides: Record<string, unknown> = {}): ServePrivateStatusRequest {
  return {
    v: 1,
    requestId: "r1",
    opId: "status:tok1",
    op: "session/status",
    idempotencyKey: "status:tok1",
    context: { directory: dir },
    payload: {},
    ...overrides,
  } as unknown as ServePrivateStatusRequest
}

function okRes(r: ServePrivateStatusRequest, statuses: Record<string, unknown>): ServePrivateStatusResult {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "session/status",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { statuses: statuses as Record<string, Record<string, unknown>> },
  }
}

function linked(handler: (method: string, params: unknown) => unknown | Promise<unknown>) {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const backend = new JsonRpcPeer({ reader: toBackend, writer: toClient, onRequest: handler as never })
  return { toClient, toBackend, backend }
}

function sdkClient(data: Record<string, SessionStatus> | Error) {
  return {
    session: {
      status: async () => {
        if (data instanceof Error) throw data
        return { data }
      },
    },
  } as unknown as Parameters<typeof seedSessionStatuses>[0]
}

describe("status private request validation (LOCK-005)", () => {
  it("accepts minimal valid request", () => {
    expect(() => validateStatusRequest(req())).not.toThrow()
  })

  it("buildStatusOpId binds token", () => {
    expect(buildStatusOpId("abc")).toBe("status:abc")
    expect(() => buildStatusOpId("")).toThrow()
    expect(() => buildStatusOpId("a:b")).toThrow()
  })

  it("rejects relative directory, payload, idempotency drift, revision cargo", () => {
    expect(() => validateStatusRequest(req("relative/path"))).toThrow()
    expect(() => validateStatusRequest(req("/repo", { payload: { filter: "busy" } }))).toThrow()
    expect(() => validateStatusRequest(req("/repo", { idempotencyKey: "status:other" }))).toThrow()
    expect(() => validateStatusRequest(req("/repo", { context: { directory: "/repo", sessionRevision: 1 } }))).toThrow()
    expect(() => validateStatusRequest(req("/repo", { context: { directory: "/repo", configVersion: 1 } }))).toThrow()
    expect(() => validateStatusRequest(req("/repo", { context: { directory: "/repo", sessionId: "ses_a" } }))).toThrow()
    expect(() => validateStatusRequest(req("/repo", { sessionRevision: 1 }))).toThrow()
  })

  it("accepts arbitrary non-empty opId when idempotencyKey matches (LOCK-005)", () => {
    expect(() => validateStatusRequest(req("/repo", { opId: "status", idempotencyKey: "status" }))).not.toThrow()
    expect(() =>
      validateStatusRequest(
        req("/repo", { opId: "cancelQueued:ses_a:msg_b", idempotencyKey: "cancelQueued:ses_a:msg_b" }),
      ),
    ).not.toThrow()
    expect(() =>
      validateStatusRequest(req("/repo", { opId: "opaque-token-123", idempotencyKey: "opaque-token-123" })),
    ).not.toThrow()
    expect(() => validateStatusRequest(req("/repo", { opId: "", idempotencyKey: "" }))).toThrow()
  })
})

describe("status private result validation", () => {
  it("accepts succeeded map and rejects binding drift", () => {
    const r = req()
    const good = okRes(r, { ses_a: { type: "busy" }, ses_b: { type: "retry", attempt: 1, message: "m", next: 5 } })
    expect(() => validateStatusResult(good, r)).not.toThrow()
    expect(() => validateStatusResult({ ...good, requestId: "other" }, r)).toThrow()
    expect(() => validateStatusResult({ ...good, data: { statuses: { ses_a: { type: "flying" } } } }, r)).toThrow()
    expect(() => validateStatusResult({ ...good, data: { statuses: "nope" } }, r)).toThrow()
    const ambiguous = { ...good, status: "ambiguous", outcome: { type: "ambiguous", time: 1 }, accepted: false, data: { statuses: {} } }
    expect(() => validateStatusResult(ambiguous, r)).toThrow()
  })

  it("rejects revision/config metadata fail-closed", () => {
    const r = req()
    const good = okRes(r, { ses_a: { type: "busy" } })
    expect(() => validateStatusResult({ ...good, revision: { session: 1, config: 2 } }, r)).toThrow()
    expect(() => validateStatusResult({ ...good, configVersion: 1 }, r)).toThrow()
    expect(() => validateStatusResult({ ...good, sessionRevision: 1 }, r)).toThrow()
  })
})

describe("compareStatusParity (SDK authoritative)", () => {
  it("matches equal maps", () => {
    const r = req()
    const priv = okRes(r, { ses_a: { type: "busy" } })
    const out = compareStatusParity(priv, { data: { ses_a: { type: "busy" } } })
    expect(out.divergence).toBeNull()
  })

  it("flags type and key drift without throwing", () => {
    const r = req()
    const priv = okRes(r, { ses_a: { type: "idle" }, ses_extra: { type: "busy" } })
    const out = compareStatusParity(priv, { data: { ses_a: { type: "busy" } } })
    expect(out.divergence).toContain("status-map-mismatch")
  })

  it("treats transportUnknown as observation-only", () => {
    const r = req()
    const priv = { ...okRes(r, {}), status: "ambiguous", accepted: false, transportUnknown: true } as unknown as ServePrivateStatusResult
    const out = compareStatusParity(priv, { data: { ses_a: { type: "busy" } } })
    expect(out.divergence).toBe("transport-unknown")
  })

  it("matches failed/failed class and ambiguous/409", () => {
    const r = req()
    const failed = {
      v: 1, requestId: r.requestId, opId: r.opId, op: "session/status", idempotencyKey: r.idempotencyKey,
      status: "failed", outcome: { type: "failed", time: 1, failure: { code: "internal", message: "x", retryable: false } },
      accepted: false, failure: { code: "internal", message: "x", retryable: false },
    } as unknown as ServePrivateStatusResult
    expect(compareStatusParity(failed, { error: { code: 500 }, response: { status: 500 } }).divergence).toBeNull()
    const ambiguous = {
      v: 1, requestId: r.requestId, opId: r.opId, op: "session/status", idempotencyKey: r.idempotencyKey,
      status: "ambiguous", outcome: { type: "ambiguous", time: 1 }, accepted: false,
    } as unknown as ServePrivateStatusResult
    expect(compareStatusParity(ambiguous, { error: { code: 409 }, response: { status: 409 } }).divergence).toBeNull()
    expect(compareStatusParity(ambiguous, { data: {} }).divergence).toContain("status-mismatch")
  })
})

describe("ServePrivatePeer status handle", () => {
  it("throws without session/status capability", async () => {
    const { toClient, toBackend, backend } = linked(async (method) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      throw new Error("unexpected")
    })
    let peer: ServePrivatePeer | undefined
    try {
      peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 11, epoch: 1, initializeTimeoutMs: 500 })
      expect(await peer.initialize(500)).toBeTrue()
      expect(() => peer.privateStatusWithHandle(req())).toThrow()
    } finally {
      if (peer) {
        try {
          peer.dispose()
        } catch (err) {
          noteCleanup("peer-dispose", err)
        }
      }
      try {
        backend.dispose()
      } catch (err) {
        noteCleanup("backend-dispose", err)
      }
      try {
        toClient.destroy()
      } catch (err) {
        noteCleanup("toClient-destroy", err)
      }
      try {
        toBackend.destroy()
      } catch (err) {
        noteCleanup("toBackend-destroy", err)
      }
    }
  })

  it("round-trips read-only map over linked channel", async () => {
    const { toClient, toBackend, backend } = linked(async (method, params) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/status"] }
      if (method === "session/status") {
        const p = params as ServePrivateStatusRequest
        return okRes(p, { ses_a: { type: "busy" } })
      }
      throw new Error("unexpected")
    })
    let peer: ServePrivatePeer | undefined
    try {
      peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 12, epoch: 2, initializeTimeoutMs: 500 })
      expect(await peer.initialize(500)).toBeTrue()
      expect(peer.hasCapability("session/status")).toBeTrue()
      const r = req("/repo")
      const res = await peer.privateStatus(r)
      expect(res.status).toBe("succeeded")
      if (res.status === "succeeded") expect(res.data.statuses["ses_a"]).toEqual({ type: "busy" })
    } finally {
      if (peer) {
        try {
          peer.dispose()
        } catch (err) {
          noteCleanup("peer-dispose", err)
        }
      }
      try {
        backend.dispose()
      } catch (err) {
        noteCleanup("backend-dispose", err)
      }
      try {
        toClient.destroy()
      } catch (err) {
        noteCleanup("toClient-destroy", err)
      }
      try {
        toBackend.destroy()
      } catch (err) {
        noteCleanup("toBackend-destroy", err)
      }
    }
  })

  it("closed transport fails closed ambiguous without retry", async () => {
    const { toClient, toBackend, backend } = linked(async (method) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/status"] }
      return new Promise(() => {})
    })
    let peer: ServePrivatePeer | undefined
    let pending: ReturnType<ServePrivatePeer["privateStatusWithHandle"]> | undefined
    try {
      peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 13, epoch: 3, initializeTimeoutMs: 500 })
      expect(await peer.initialize(500)).toBeTrue()
      pending = peer.privateStatusWithHandle(req())
      expect(peer.getPendingCount()).toBe(1)
      peer.dispose()
      const res = await pending.promise
      expect(res.status).toBe("ambiguous")
      expect((res as { transportUnknown?: boolean }).transportUnknown).toBeTrue()
    } finally {
      if (pending && peer) {
        try {
          pending.cancel("test cleanup")
        } catch (err) {
          noteCleanup("status-handle-cancel", err)
        }
      }
      if (peer) {
        try {
          peer.dispose()
        } catch (err) {
          noteCleanup("peer-dispose", err)
        }
      }
      try {
        backend.dispose()
      } catch (err) {
        noteCleanup("backend-dispose", err)
      }
      try {
        toClient.destroy()
      } catch (err) {
        noteCleanup("toClient-destroy", err)
      }
      try {
        toBackend.destroy()
      } catch (err) {
        noteCleanup("toBackend-destroy", err)
      }
    }
  })

  it("timeout cancel owns exact id with no leak", async () => {
    const { toClient, toBackend, backend } = linked(async (method) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/status"] }
      return new Promise(() => {})
    })
    let peer: ServePrivatePeer | undefined
    try {
      peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 14, epoch: 4, initializeTimeoutMs: 500 })
      expect(await peer.initialize(500)).toBeTrue()
      const handle = peer.privateStatusWithHandle(req())
      expect(peer.getPendingCount()).toBe(1)
      expect(handle.cancel("private parity timeout")).toBeTrue()
      expect(peer.getPendingCount()).toBe(0)
      const res = await handle.promise
      expect(res.status).toBe("ambiguous")
      expect((res as { transportUnknown?: boolean }).transportUnknown).toBeTrue()
    } finally {
      if (peer) {
        try {
          peer.dispose()
        } catch (err) {
          noteCleanup("peer-dispose", err)
        }
      }
      try {
        backend.dispose()
      } catch (err) {
        noteCleanup("backend-dispose", err)
      }
      try {
        toClient.destroy()
      } catch (err) {
        noteCleanup("toClient-destroy", err)
      }
      try {
        toBackend.destroy()
      } catch (err) {
        noteCleanup("toBackend-destroy", err)
      }
    }
  })
})

describe("connection-service status epoch/cancel ownership", () => {
  it("throws when private unavailable", async () => {
    const { KiloConnectionService } = await import("../../src/services/cli-backend/connection-service")
    const svc = new KiloConnectionService({} as never)
    let err: unknown
    try {
      await svc.privateStatus(req())
    } catch (e) {
      err = e
    }
    expect(String(err)).toContain("Private peer unavailable")
  })

  it("epoch drift and peer replacement fail closed ambiguous", async () => {
    const { KiloConnectionService } = await import("../../src/services/cli-backend/connection-service")
    const svc = new KiloConnectionService({} as never)
    let release!: (v: ServePrivateStatusResult) => void
    const gate = new Promise<ServePrivateStatusResult>((resolve) => {
      release = resolve
    })
    const fake = {
      isAvailable: () => true,
      hasCapability: () => true,
      privateStatusWithHandle: (r: ServePrivateStatusRequest) => ({ id: 41, promise: gate, cancel: () => true }),
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    ;(svc as unknown as { privatePeer: unknown }).privatePeer = fake
    ;(svc as unknown as { privateAvailable: boolean }).privateAvailable = true
    ;(svc as unknown as { privateEpoch: number | null }).privateEpoch = 9
    const r = req()
    const pending = svc.privateStatusWithHandle(r).promise
    // epoch drift before settle
    ;(svc as unknown as { privateEpoch: number | null }).privateEpoch = 10
    release(okRes(r, { ses_a: { type: "busy" } }))
    const drifted = await pending
    expect(drifted.status).toBe("ambiguous")
    expect((drifted as { transportUnknown?: boolean }).transportUnknown).toBeTrue()
    // peer replacement before settle
    ;(svc as unknown as { privateEpoch: number | null }).privateEpoch = 10
    let release2!: (v: ServePrivateStatusResult) => void
    const gate2 = new Promise<ServePrivateStatusResult>((resolve) => {
      release2 = resolve
    })
    const fake2 = { ...fake, privateStatusWithHandle: () => ({ id: 42, promise: gate2, cancel: () => true }) }
    ;(svc as unknown as { privatePeer: unknown }).privatePeer = fake2
    const pending2 = svc.privateStatusWithHandle(r).promise
    ;(svc as unknown as { privatePeer: unknown }).privatePeer = fake
    release2(okRes(r, {}))
    const replaced = await pending2
    expect(replaced.status).toBe("ambiguous")
    expect((replaced as { transportUnknown?: boolean }).transportUnknown).toBeTrue()
  })
})

describe("seedSessionStatuses SDK-first parity observer", () => {
  it("applies SDK result and never lets private divergence touch map or posts", async () => {
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    const map = new Map<string, SessionStatus["type"]>([["ses_stale", "busy"]])
    const msgs: unknown[] = []
    let seen: unknown = null
    const connection = {
      isPrivateAvailable: () => true,
      privateStatusWithHandle: (r: ServePrivateStatusRequest) => {
        seen = r
        return { id: 1, promise: Promise.resolve(okRes(r, { ses_a: { type: "idle" }, ses_ghost: { type: "busy" } })), cancel: () => true }
      },
      privateStatus: async () => {
        throw new Error("unused")
      },
    }
    await seedSessionStatuses(client, "/repo", map, (m) => msgs.push(m), true, { connection })
    expect(map.get("ses_a")).toBe("busy")
    expect(map.get("ses_ghost")).toBeUndefined()
    expect(map.get("ses_stale")).toBe("idle")
    expect(msgs).toEqual([
      { type: "sessionStatus", sessionID: "ses_a", status: "busy" },
      { type: "sessionStatus", sessionID: "ses_stale", status: "idle" },
    ])
    const sent = seen as unknown as Record<string, unknown>
    expect(sent.op).toBe("session/status")
    expect(sent.idempotencyKey).toBe(sent.opId)
    expect(String(sent.opId).startsWith("status:")).toBeTrue()
    expect((sent.context as Record<string, unknown>).directory).toBe("/repo")
    expect(sent.payload).toEqual({})
  })

  it("skips observer when private unavailable and preserves reconcile=false", async () => {
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    const map = new Map<string, SessionStatus["type"]>([["ses_stale", "busy"]])
    const msgs: unknown[] = []
    let calls = 0
    const connection = {
      isPrivateAvailable: () => false,
      privateStatusWithHandle: () => {
        calls += 1
        return { id: 1, promise: Promise.resolve({}), cancel: () => true }
      },
      privateStatus: async () => ({}),
    }
    await seedSessionStatuses(client, "/repo", map, (m) => msgs.push(m), false, { connection })
    expect(calls).toBe(0)
    expect(map.get("ses_stale")).toBe("busy")
    expect(msgs).toEqual([{ type: "sessionStatus", sessionID: "ses_a", status: "busy" }])
  })

  it("timeout fails closed ambiguous and keeps SDK result", async () => {
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    const map = new Map<string, SessionStatus["type"]>()
    const msgs: unknown[] = []
    const gate = deferred<boolean>()
    const connection = {
      isPrivateAvailable: () => true,
      privateStatusWithHandle: () => ({
        id: 9,
        promise: new Promise(() => {}),
        cancel: () => {
          gate.resolve(true)
          return true
        },
      }),
      privateStatus: async () => new Promise(() => {}),
    }
    await seedSessionStatuses(client, "/repo", map, (m) => msgs.push(m), true, { connection, timeoutMs: 50 })
    expect(map.get("ses_a")).toBe("busy")
    expect(msgs).toEqual([{ type: "sessionStatus", sessionID: "ses_a", status: "busy" }])
    await withDeadline(gate.promise, 2000, "observer timeout cancel")
    expect(await gate.promise).toBeTrue()
  })

  it("SDK failure never calls private and never posts", async () => {
    const client = sdkClient(new Error("boom"))
    const map = new Map<string, SessionStatus["type"]>()
    const msgs: unknown[] = []
    let calls = 0
    const connection = {
      isPrivateAvailable: () => true,
      privateStatusWithHandle: () => {
        calls += 1
        return { id: 1, promise: Promise.resolve({}), cancel: () => true }
      },
      privateStatus: async () => ({}),
    }
    await seedSessionStatuses(client, "/repo", map, (m) => msgs.push(m), true, { connection })
    expect(calls).toBe(0)
    expect(msgs).toEqual([])
  })

  it("late private negotiation triggers exactly one read-only observation (SDK stays authoritative)", async () => {
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    const map = new Map<string, SessionStatus["type"]>()
    const msgs: unknown[] = []
    let available = false
    const listeners = new Set<() => void>()
    const observed = deferred<number>()
    let calls = 0
    const connection = {
      isPrivateAvailable: () => available,
      privateStatusWithHandle: (r: ServePrivateStatusRequest) => {
        calls += 1
        if (calls === 1) observed.resolve(1)
        return {
          id: 1,
          promise: Promise.resolve(okRes(r, { ses_a: { type: "idle" }, ses_ghost: { type: "busy" } })),
          cancel: () => true,
        }
      },
      privateStatus: async () => ({}),
      onPrivateAvailable: (fn: () => void) => {
        listeners.add(fn)
        return () => {
          listeners.delete(fn)
        }
      },
    }
    await seedSessionStatuses(client, "/repo", map, (m) => msgs.push(m), true, { connection })
    expect(calls).toBe(0)
    expect(map.get("ses_a")).toBe("busy")
    expect(msgs).toEqual([{ type: "sessionStatus", sessionID: "ses_a", status: "busy" }])
    available = true
    for (const fn of [...listeners]) fn()
    await withDeadline(observed.promise, 2000, "deferred parity observation")
    expect(calls).toBe(1)
    expect(map.get("ses_a")).toBe("busy")
    expect(map.get("ses_ghost")).toBeUndefined()
    expect(msgs).toHaveLength(1)
    for (const fn of [...listeners]) fn()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(1)
  })
})

describe("observer timeout cancel ownership (LOCK-007)", () => {
  it("exact cancel success keeps peer (no invalidate)", async () => {
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    const map = new Map<string, SessionStatus["type"]>()
    const msgs: unknown[] = []
    let invalidated = 0
    const gate = deferred<boolean>()
    const connection = {
      isPrivateAvailable: () => true,
      privateStatusWithHandle: () => ({
        id: 7,
        promise: new Promise(() => {}),
        cancel: () => {
          gate.resolve(true)
          return true
        },
      }),
      privateStatus: async () => new Promise(() => {}),
      invalidatePrivatePeerOnObserverTimeout: () => {
        invalidated += 1
      },
    }
    await seedSessionStatuses(client, "/repo", map, (m) => msgs.push(m), true, { connection, timeoutMs: 50 })
    expect(map.get("ses_a")).toBe("busy")
    await withDeadline(gate.promise, 2000, "exact cancel")
    expect(await gate.promise).toBeTrue()
    await Promise.resolve()
    await Promise.resolve()
    expect(invalidated).toBe(0)
    expect(msgs).toEqual([{ type: "sessionStatus", sessionID: "ses_a", status: "busy" }])
  })

  it("exact cancel miss invalidates peer", async () => {
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    const map = new Map<string, SessionStatus["type"]>()
    const msgs: unknown[] = []
    const gate = deferred<number>()
    let invalidated = 0
    const connection = {
      isPrivateAvailable: () => true,
      privateStatusWithHandle: () => ({ id: 8, promise: new Promise(() => {}), cancel: () => false }),
      privateStatus: async () => new Promise(() => {}),
      invalidatePrivatePeerOnObserverTimeout: () => {
        invalidated += 1
        if (invalidated === 1) gate.resolve(1)
      },
    }
    await seedSessionStatuses(client, "/repo", map, (m) => msgs.push(m), true, { connection, timeoutMs: 50 })
    expect(map.get("ses_a")).toBe("busy")
    await withDeadline(gate.promise, 2000, "cancel miss invalidate")
    expect(invalidated).toBe(1)
    expect(msgs).toEqual([{ type: "sessionStatus", sessionID: "ses_a", status: "busy" }])
  })

  it("cancel throw invalidates peer", async () => {
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    const map = new Map<string, SessionStatus["type"]>()
    const msgs: unknown[] = []
    const gate = deferred<number>()
    let invalidated = 0
    const connection = {
      isPrivateAvailable: () => true,
      privateStatusWithHandle: () => ({
        id: 9,
        promise: new Promise(() => {}),
        cancel: () => {
          throw new Error("cancel blew up")
        },
      }),
      privateStatus: async () => new Promise(() => {}),
      invalidatePrivatePeerOnObserverTimeout: () => {
        invalidated += 1
        if (invalidated === 1) gate.resolve(1)
      },
    }
    await seedSessionStatuses(client, "/repo", map, (m) => msgs.push(m), true, { connection, timeoutMs: 50 })
    expect(map.get("ses_a")).toBe("busy")
    await withDeadline(gate.promise, 2000, "cancel throw invalidate")
    expect(invalidated).toBe(1)
  })
})

describe("status result full-field validation (B5 complete SessionStatus)", () => {
  const action = { reason: "r", provider: "p", title: "t", message: "m", label: "l" }

  it("accepts retry action with and without optional link", () => {
    const r = req()
    expect(() =>
      validateStatusResult(okRes(r, { ses_a: { type: "retry", attempt: 1, message: "m", next: 5, action } }), r),
    ).not.toThrow()
    expect(() =>
      validateStatusResult(
        okRes(r, { ses_a: { type: "retry", attempt: 0, message: "m", next: 0, action: { ...action, link: "https://x" } } }),
        r,
      ),
    ).not.toThrow()
  })

  it("rejects retry action with missing/bad/foreign fields", () => {
    const r = req()
    const { label: _drop, ...noLabel } = action
    expect(() =>
      validateStatusResult(okRes(r, { ses_a: { type: "retry", attempt: 1, message: "m", next: 5, action: noLabel } }), r),
    ).toThrow()
    expect(() =>
      validateStatusResult(
        okRes(r, { ses_a: { type: "retry", attempt: 1, message: "m", next: 5, action: { ...action, link: 42 } } }),
        r,
      ),
    ).toThrow()
    expect(() =>
      validateStatusResult(okRes(r, { ses_a: { type: "retry", attempt: 1, message: "m", next: 5, action: "x" } }), r),
    ).toThrow()
    expect(() =>
      validateStatusResult(
        okRes(r, { ses_a: { type: "retry", attempt: 1, message: "m", next: 5, action: { ...action, extra: 1 } } }),
        r,
      ),
    ).toThrow()
  })

  it("accepts offline with que requestID and rejects bad requestID/message", () => {
    const r = req()
    expect(() =>
      validateStatusResult(okRes(r, { ses_a: { type: "offline", requestID: "que_1", message: "m" } }), r),
    ).not.toThrow()
    expect(() => validateStatusResult(okRes(r, { ses_a: { type: "offline", message: "m" } }), r)).toThrow()
    expect(() => validateStatusResult(okRes(r, { ses_a: { type: "offline", requestID: "", message: "m" } }), r)).toThrow()
    expect(() =>
      validateStatusResult(okRes(r, { ses_a: { type: "offline", requestID: "ses_x", message: "m" } }), r),
    ).toThrow()
    expect(() => validateStatusResult(okRes(r, { ses_a: { type: "offline", requestID: "que_1" } }), r)).toThrow()
  })

  it("rejects foreign semantic fields per type", () => {
    const r = req()
    expect(() => validateStatusResult(okRes(r, { ses_a: { type: "idle", attempt: 1 } }), r)).toThrow()
    expect(() => validateStatusResult(okRes(r, { ses_a: { type: "busy", requestID: "que_1" } }), r)).toThrow()
    expect(() =>
      validateStatusResult(okRes(r, { ses_a: { type: "retry", attempt: 1, message: "m", next: 5, requestID: "que_1" } }), r),
    ).toThrow()
    expect(() =>
      validateStatusResult(okRes(r, { ses_a: { type: "offline", requestID: "que_1", message: "m", next: 5 } }), r),
    ).toThrow()
  })
})

describe("compareStatusParity full-field divergence (B5)", () => {
  const action = { reason: "r", provider: "p", title: "t", message: "m", label: "l" }

  it("flags retry attempt/message/next drift", () => {
    const r = req()
    const base = { type: "retry", attempt: 1, message: "m", next: 5 }
    for (const variant of [
      { ...base, attempt: 2 },
      { ...base, message: "other" },
      { ...base, next: 9 },
    ]) {
      const out = compareStatusParity(okRes(r, { ses_a: variant }), { data: { ses_a: base } })
      expect(out.divergence).toContain("status-map-mismatch")
      expect(out.details.fieldMismatch).toEqual(["ses_a"])
    }
    expect(compareStatusParity(okRes(r, { ses_a: base }), { data: { ses_a: base } }).divergence).toBeNull()
  })

  it("flags retry action nested drift including optional link, matches equal actions", () => {
    const r = req()
    const sdk = { type: "retry", attempt: 1, message: "m", next: 5, action }
    const drifted = { ...sdk, action: { ...action, label: "other" } }
    const out = compareStatusParity(okRes(r, { ses_a: drifted }), { data: { ses_a: sdk } })
    expect(out.divergence).toContain("status-map-mismatch")
    expect(out.details.fields).toEqual([{ sid: "ses_a", field: "action.label" }])
    const linkDrift = { ...sdk, action: { ...action, link: "https://x" } }
    expect(compareStatusParity(okRes(r, { ses_a: linkDrift }), { data: { ses_a: sdk } }).divergence).toContain(
      "status-map-mismatch",
    )
    const missingAction = { type: "retry", attempt: 1, message: "m", next: 5 }
    expect(compareStatusParity(okRes(r, { ses_a: missingAction }), { data: { ses_a: sdk } }).divergence).toContain(
      "status-map-mismatch",
    )
    expect(compareStatusParity(okRes(r, { ses_a: sdk }), { data: { ses_a: sdk } }).divergence).toBeNull()
  })

  it("flags offline requestID/message drift, matches equal offline", () => {
    const r = req()
    const sdk = { type: "offline", requestID: "que_1", message: "m" }
    expect(
      compareStatusParity(okRes(r, { ses_a: { ...sdk, requestID: "que_2" } }), { data: { ses_a: sdk } }).divergence,
    ).toContain("status-map-mismatch")
    expect(
      compareStatusParity(okRes(r, { ses_a: { ...sdk, message: "other" } }), { data: { ses_a: sdk } }).divergence,
    ).toContain("status-map-mismatch")
    expect(compareStatusParity(okRes(r, { ses_a: sdk }), { data: { ses_a: sdk } }).divergence).toBeNull()
  })
})

describe("deferred observer dedupe (B5)", () => {
  function fallbackConnection() {
    let available = false
    const listeners = new Set<() => void>()
    let calls = 0
    const gates: Array<(n: number) => void> = []
    const onCall = (n: number): Promise<number> => {
      const gate = deferred<number>()
      if (n <= calls) gate.resolve(calls)
      else gates.push((c) => {
        if (c >= n) gate.resolve(c)
      })
      return withDeadline(gate.promise, 2000, `deferred observation ${n}`)
    }
    const connection = {
      isPrivateAvailable: () => available,
      privateStatusWithHandle: (r: ServePrivateStatusRequest) => {
        calls += 1
        for (const notify of [...gates]) notify(calls)
        return { id: 1, promise: Promise.resolve(okRes(r, { ses_a: { type: "busy" } })), cancel: () => true }
      },
      privateStatus: async () => ({}),
      onPrivateAvailable: (fn: () => void) => {
        listeners.add(fn)
        return () => {
          listeners.delete(fn)
        }
      },
    }
    return {
      connection,
      listeners,
      calls: () => calls,
      onCall,
      setAvailable: (v: boolean) => {
        available = v
      },
      fire: () => {
        for (const fn of [...listeners]) fn()
      },
    }
  }

  it("duplicate seeds same epoch/directory share one deferred observation; SDK map/reconcile preserved", async () => {
    const fake = fallbackConnection()
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    const map1 = new Map<string, SessionStatus["type"]>([["ses_stale", "busy"]])
    const msgs1: unknown[] = []
    const map2 = new Map<string, SessionStatus["type"]>([["ses_stale", "busy"]])
    const msgs2: unknown[] = []
    await seedSessionStatuses(client, "/repo", map1, (m) => msgs1.push(m), true, { connection: fake.connection })
    await seedSessionStatuses(client, "/repo", map2, (m) => msgs2.push(m), true, { connection: fake.connection })
    expect(fake.listeners.size).toBe(1)
    expect(map1.get("ses_a")).toBe("busy")
    expect(map1.get("ses_stale")).toBe("idle")
    expect(map2.get("ses_a")).toBe("busy")
    expect(map2.get("ses_stale")).toBe("idle")
    expect(msgs1).toHaveLength(2)
    expect(msgs2).toHaveLength(2)
    const first = fake.onCall(1)
    fake.setAvailable(true)
    fake.fire()
    await first
    expect(fake.calls()).toBe(1)
    expect(map1.get("ses_ghost")).toBeUndefined()
    expect(map2.get("ses_ghost")).toBeUndefined()
  })

  it("different directories observe independently", async () => {
    const fake = fallbackConnection()
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    await seedSessionStatuses(client, "/a", new Map(), () => {}, true, { connection: fake.connection })
    await seedSessionStatuses(client, "/b", new Map(), () => {}, true, { connection: fake.connection })
    expect(fake.listeners.size).toBe(2)
    const both = fake.onCall(2)
    fake.setAvailable(true)
    fake.fire()
    await both
    expect(fake.calls()).toBe(2)
  })

  it("delegated keyed registration dedupes via the connection", async () => {
    const fns = new Set<() => void>()
    const dirs: string[] = []
    const connection = {
      isPrivateAvailable: () => false,
      privateStatusWithHandle: () => ({ id: 1, promise: Promise.resolve({}), cancel: () => true }),
      privateStatus: async () => ({}),
      addDeferredStatusObserver: (dir: string, fn: () => void) => {
        dirs.push(dir)
        if ([...fns].length > 0 && dirs.filter((d) => d === dir).length > 1) return () => {}
        fns.add(fn)
        return () => {
          fns.delete(fn)
        }
      },
    }
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    await seedSessionStatuses(client, "/repo", new Map(), () => {}, true, { connection })
    await seedSessionStatuses(client, "/repo", new Map(), () => {}, true, { connection })
    expect(dirs).toEqual(["/repo", "/repo"])
    expect(fns.size).toBe(1)
  })
})

describe("failed negotiation listener cleanup (B5)", () => {
  async function service() {
    const { KiloConnectionService } = await import("../../src/services/cli-backend/connection-service")
    const svc = new KiloConnectionService({} as never)
    const anySvc = svc as unknown as {
      privateEpoch: number | null
      privateAvailable: boolean
      privateAvailableListeners: Set<() => void>
      deferredStatusObservers: Map<string, () => void>
      completePrivateNegotiation: (peer: unknown, ok: boolean, pid: number | undefined, epoch: number) => void
      addDeferredStatusObserver: (dir: string, listener: () => void) => () => void
    }
    return { svc, anySvc }
  }

  it("definitive failure clears deferred + generic listeners without notifying", async () => {
    const { anySvc } = await service()
    anySvc.privateEpoch = 7
    let fired = 0
    anySvc.privateAvailableListeners.add(() => {
      fired += 1
    })
    anySvc.addDeferredStatusObserver("/repo", () => {
      fired += 1
    })
    expect(anySvc.privateAvailableListeners.size).toBe(2)
    expect(anySvc.deferredStatusObservers.size).toBe(1)
    anySvc.completePrivateNegotiation({ isAvailable: () => false }, false, 123, 7)
    expect(anySvc.privateAvailable).toBe(false)
    expect(fired).toBe(0)
    expect(anySvc.privateAvailableListeners.size).toBe(0)
    expect(anySvc.deferredStatusObservers.size).toBe(0)
  })

  it("unavailable peer with ok=true also fails closed without notifying", async () => {
    const { anySvc } = await service()
    anySvc.privateEpoch = 7
    let fired = 0
    anySvc.addDeferredStatusObserver("/repo", () => {
      fired += 1
    })
    anySvc.completePrivateNegotiation({ isAvailable: () => false }, true, 123, 7)
    expect(anySvc.privateAvailable).toBe(false)
    expect(fired).toBe(0)
    expect(anySvc.privateAvailableListeners.size).toBe(0)
    expect(anySvc.deferredStatusObservers.size).toBe(0)
  })

  it("stale failure never clears a newer epoch's listeners", async () => {
    const { anySvc } = await service()
    anySvc.privateEpoch = 8
    let fired = 0
    anySvc.privateAvailableListeners.add(() => {
      fired += 1
    })
    anySvc.addDeferredStatusObserver("/repo", () => {
      fired += 1
    })
    anySvc.completePrivateNegotiation({ isAvailable: () => false }, false, 123, 7)
    expect(anySvc.privateAvailableListeners.size).toBe(2)
    expect(anySvc.deferredStatusObservers.size).toBe(1)
    expect(fired).toBe(0)
  })

  it("duplicate keyed registrations share one entry; success still notifies once", async () => {
    const { anySvc } = await service()
    anySvc.privateEpoch = 9
    let fired = 0
    const inc = () => {
      fired += 1
    }
    anySvc.addDeferredStatusObserver("/repo", inc)
    const noop = anySvc.addDeferredStatusObserver("/repo", inc)
    expect(anySvc.deferredStatusObservers.size).toBe(1)
    expect(anySvc.privateAvailableListeners.size).toBe(1)
    expect(() => noop()).not.toThrow()
    expect(anySvc.deferredStatusObservers.size).toBe(1)
    anySvc.addDeferredStatusObserver("/other", inc)
    expect(anySvc.deferredStatusObservers.size).toBe(2)
    anySvc.completePrivateNegotiation({ isAvailable: () => true }, true, 123, 9)
    expect(anySvc.privateAvailable).toBe(true)
    expect(fired).toBe(2)
    expect(anySvc.deferredStatusObservers.size).toBe(0)
    expect(anySvc.privateAvailableListeners.size).toBe(0)
  })
})

describe("status result strict allowlists (B5 audit blocker)", () => {
  function failedRes(r: ServePrivateStatusRequest, extra: Record<string, unknown> = {}): unknown {
    return {
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: "session/status",
      idempotencyKey: r.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "internal", message: "x", retryable: false } },
      accepted: false,
      failure: { code: "internal", message: "x", retryable: false },
      ...extra,
    }
  }

  function ambiguousRes(r: ServePrivateStatusRequest, extra: Record<string, unknown> = {}): unknown {
    return {
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: "session/status",
      idempotencyKey: r.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      ...extra,
    }
  }

  it("rejects unknown root/outcome/failure fields", () => {
    const r = req()
    expect(() => validateStatusResult({ ...okRes(r, { ses_a: { type: "busy" } }), extra: 1 }, r)).toThrow()
    expect(() => validateStatusResult({ ...okRes(r, { ses_a: { type: "busy" } }), _error: "x" }, r)).toThrow()
    expect(() =>
      validateStatusResult(
        { ...okRes(r, { ses_a: { type: "busy" } }), outcome: { type: "succeeded", time: 1, extra: 1 } },
        r,
      ),
    ).toThrow()
    expect(() => validateStatusResult(failedRes(r, { failure: { code: "internal", message: "x", retryable: false, extra: 1 } }), r)).toThrow()
    expect(() =>
      validateStatusResult(
        failedRes(r, {
          outcome: { type: "failed", time: 1, failure: { code: "internal", message: "x", retryable: false, extra: 1 } },
        }),
        r,
      ),
    ).toThrow()
    expect(() => validateStatusResult(failedRes(r, { data: { statuses: {} } }), r)).toThrow()
    expect(() => validateStatusResult(ambiguousRes(r, { data: { statuses: {} } }), r)).toThrow()
    expect(() => validateStatusResult(ambiguousRes(r, { failure: { code: "x", message: "y", retryable: false } }), r)).toThrow()
  })

  it("rejects malformed optional failure.detail and mirrored detail drift", () => {
    const r = req()
    expect(() =>
      validateStatusResult(failedRes(r, { failure: { code: "internal", message: "x", retryable: false, detail: 42 } }), r),
    ).toThrow()
    expect(() =>
      validateStatusResult(
        failedRes(r, {
          outcome: { type: "failed", time: 1, failure: { code: "internal", message: "x", retryable: false, detail: 42 } },
        }),
        r,
      ),
    ).toThrow()
    const good = failedRes(r, {
      failure: { code: "internal", message: "x", retryable: false, detail: "d" },
      outcome: { type: "failed", time: 1, failure: { code: "internal", message: "x", retryable: false, detail: "other" } },
    })
    expect(() => validateStatusResult(good, r)).toThrow()
    const matched = failedRes(r, {
      failure: { code: "internal", message: "x", retryable: false, detail: "d" },
      outcome: { type: "failed", time: 1, failure: { code: "internal", message: "x", retryable: false, detail: "d" } },
    })
    expect(() => validateStatusResult(matched, r)).not.toThrow()
  })

  it("rejects transportUnknown on succeeded/failed and revision cargo on every branch", () => {
    const r = req()
    expect(() => validateStatusResult({ ...okRes(r, {}), transportUnknown: true }, r)).toThrow()
    expect(() => validateStatusResult(failedRes(r, { transportUnknown: true }), r)).toThrow()
    expect(() => validateStatusResult(ambiguousRes(r, { revision: { session: 1, config: 1 } }), r)).toThrow()
    expect(() =>
      validateStatusResult({ ...okRes(r, {}), outcome: { type: "succeeded", time: 1, data: {} } }, r),
    ).toThrow()
    expect(() =>
      validateStatusResult({ ...ambiguousRes(r), outcome: { type: "ambiguous", time: 1, data: {} } }, r),
    ).toThrow()
  })

  it("accepts valid success/failure/ambiguous shapes", () => {
    const r = req()
    expect(() => validateStatusResult(okRes(r, { ses_a: { type: "busy" } }), r)).not.toThrow()
    expect(() => validateStatusResult(okRes(r, { ses_a: { type: "offline", requestID: "que_1", message: "m" } }), r)).not.toThrow()
    expect(() => validateStatusResult(failedRes(r), r)).not.toThrow()
    expect(() => validateStatusResult(ambiguousRes(r), r)).not.toThrow()
    expect(() => validateStatusResult(ambiguousRes(r, { transportUnknown: true }), r)).not.toThrow()
  })
})

describe("invalid private result never reaches normal parity compare (LOCK-008)", () => {
  it("logs validation divergence and keeps SDK map/posts authoritative", async () => {
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    const map = new Map<string, SessionStatus["type"]>()
    const msgs: unknown[] = []
    const warns: string[] = []
    const latch = warnLatch("validation divergence")
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      const msg = String(a[0])
      warns.push(msg)
      latch.onWarn(msg)
    }
    try {
      const connection = {
        isPrivateAvailable: () => true,
        privateStatusWithHandle: (r: ServePrivateStatusRequest) => ({
          id: 1,
          promise: Promise.resolve({ ...okRes(r, { ses_a: { type: "busy" } }), extra: 1 }),
          cancel: () => true,
        }),
        privateStatus: async () => ({}),
      }
      await seedSessionStatuses(client, "/repo", map, (m) => msgs.push(m), true, { connection })
      await latch.promise
    } finally {
      console.warn = orig
    }
    expect(map.get("ses_a")).toBe("busy")
    expect(msgs).toEqual([{ type: "sessionStatus", sessionID: "ses_a", status: "busy" }])
    expect(warns.some((w) => w.includes("validation divergence"))).toBeTrue()
    expect(warns.some((w) => w.includes("parity divergence"))).toBeFalse()
  })

  it("malformed failure.detail is validation divergence, not parity-equal", async () => {
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    const map = new Map<string, SessionStatus["type"]>()
    const msgs: unknown[] = []
    const warns: string[] = []
    const latch = warnLatch("validation divergence")
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      const msg = String(a[0])
      warns.push(msg)
      latch.onWarn(msg)
    }
    try {
      const connection = {
        isPrivateAvailable: () => true,
        privateStatusWithHandle: (r: ServePrivateStatusRequest) => ({
          id: 1,
          promise: Promise.resolve({
            v: 1,
            requestId: r.requestId,
            opId: r.opId,
            op: "session/status",
            idempotencyKey: r.idempotencyKey,
            status: "failed",
            outcome: { type: "failed", time: 1, failure: { code: "internal", message: "x", retryable: false, detail: 42 } },
            accepted: false,
            failure: { code: "internal", message: "x", retryable: false, detail: 42 },
          }),
          cancel: () => true,
        }),
        privateStatus: async () => ({}),
      }
      await seedSessionStatuses(client, "/repo", map, (m) => msgs.push(m), true, { connection })
      await latch.promise
    } finally {
      console.warn = orig
    }
    expect(map.get("ses_a")).toBe("busy")
    expect(warns.some((w) => w.includes("validation divergence"))).toBeTrue()
    expect(warns.some((w) => w.includes("parity divergence"))).toBeFalse()
  })
})

describe("fallback stale epoch does not fire (B5)", () => {
  it("epoch change between defer and fire skips observation and cleans up", async () => {
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    let epoch: number | null = 1
    const listeners = new Set<() => void>()
    const fired = deferred<void>()
    let calls = 0
    const connection = {
      isPrivateAvailable: () => false,
      privateStatusWithHandle: (r: ServePrivateStatusRequest) => {
        calls += 1
        return { id: 1, promise: Promise.resolve(okRes(r, {})), cancel: () => true }
      },
      privateStatus: async () => ({}),
      getPrivateEpoch: () => epoch,
      onPrivateAvailable: (fn: () => void) => {
        const wrapped = (): void => {
          fn()
          fired.resolve()
        }
        listeners.add(wrapped)
        return () => {
          listeners.delete(wrapped)
        }
      },
    }
    await seedSessionStatuses(client, "/repo", new Map(), () => {}, true, { connection })
    expect(listeners.size).toBe(1)
    epoch = 2
    for (const fn of [...listeners]) fn()
    await withDeadline(fired.promise, 2000, "stale deferred fire")
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(0)
    expect(listeners.size).toBe(0)
  })
})

describe("failure.detail presence mirror strict (B5 final blocker)", () => {
  function failedRes(r: ServePrivateStatusRequest, top: Record<string, unknown>, out: Record<string, unknown>): unknown {
    return {
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: "session/status",
      idempotencyKey: r.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "internal", message: "x", retryable: false, ...out } },
      accepted: false,
      failure: { code: "internal", message: "x", retryable: false, ...top },
    }
  }

  it("both absent passes, both empty passes, matched non-empty passes", () => {
    const r = req()
    expect(() => validateStatusResult(failedRes(r, {}, {}), r)).not.toThrow()
    expect(() => validateStatusResult(failedRes(r, { detail: "" }, { detail: "" }), r)).not.toThrow()
    expect(() => validateStatusResult(failedRes(r, { detail: "d" }, { detail: "d" }), r)).not.toThrow()
  })

  it("one absent/one present rejected including empty-string presence", () => {
    const r = req()
    expect(() => validateStatusResult(failedRes(r, { detail: "" }, {}), r)).toThrow()
    expect(() => validateStatusResult(failedRes(r, {}, { detail: "" }), r)).toThrow()
    expect(() => validateStatusResult(failedRes(r, { detail: "d" }, {}), r)).toThrow()
    expect(() => validateStatusResult(failedRes(r, {}, { detail: "d" }), r)).toThrow()
  })
})

describe("invalid wire is explicit outcome, never normal result (LOCK-008/LOCK-013)", () => {
  async function linkedStatusPeer(handler: (method: string, params: unknown) => unknown) {
    let toClient: PassThrough | undefined
    let toBackend: PassThrough | undefined
    let backend: JsonRpcPeer | undefined
    let peer: ServePrivatePeer | undefined
    try {
      toClient = new PassThrough()
      toBackend = new PassThrough()
      backend = new JsonRpcPeer({ reader: toBackend, writer: toClient, onRequest: handler as never })
      peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 91, epoch: 91, initializeTimeoutMs: 500 })
      expect(await peer.initialize(500)).toBeTrue()
      const out = {
        peer: peer as ServePrivatePeer,
        backend: backend as JsonRpcPeer,
        toClient: toClient as PassThrough,
        toBackend: toBackend as PassThrough,
      }
      backend = undefined
      peer = undefined
      toClient = undefined
      toBackend = undefined
      return out
    } catch (err) {
      if (peer) {
        try {
          peer.dispose()
        } catch (cleanupErr) {
          noteCleanup("peer-dispose", cleanupErr)
        }
      }
      if (backend) {
        try {
          backend.dispose()
        } catch (cleanupErr) {
          noteCleanup("backend-dispose", cleanupErr)
        }
      }
      if (toClient) {
        try {
          toClient.destroy()
        } catch (cleanupErr) {
          noteCleanup("toClient-destroy", cleanupErr)
        }
      }
      if (toBackend) {
        try {
          toBackend.destroy()
        } catch (cleanupErr) {
          noteCleanup("toBackend-destroy", cleanupErr)
        }
      }
      throw err
    }
  }

  it("normalize maps malformed raw to invalid outcome; valid raw stays valid", async () => {
    const r = req()
    const malformed = { ...okRes(r, { ses_a: { type: "busy" } }), extra: 1 }
    const bad = normalizePrivateStatusWire(malformed, r)
    expect(bad.kind).toBe("invalid")
    if (bad.kind === "invalid") expect(bad.detail.length).toBeGreaterThan(0)
    const good = normalizePrivateStatusWire(okRes(r, { ses_a: { type: "busy" } }), r)
    expect(good.kind).toBe("valid")
    if (good.kind === "valid") {
      expect(good.result.status).toBe("succeeded")
      expect("__privateValidationFailed" in (good.result as unknown as Record<string, unknown>)).toBeFalse()
    }
  })

  it("malformed raw rejects public handle and resolves invalid outcome handle", async () => {
    const r = req()
    const { peer, backend, toClient, toBackend } = await linkedStatusPeer(async (method, params) => {
      if (method === "initialize")
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/status"] }
      if (method === "session/status") {
        const q = params as ServePrivateStatusRequest
        return { ...okRes(q, { ses_a: { type: "busy" } }), extra: 1 }
      }
      throw new Error("unexpected")
    })
    try {
      let err: unknown
      try {
        await peer.privateStatus(r)
      } catch (e) {
        err = e
      }
      expect(isPrivateStatusValidationError(err)).toBeTrue()
      const handle = peer.privateStatusOutcomeWithHandle(r)
      const out = await handle.promise
      expect(out.kind).toBe("invalid")
      if (out.kind === "invalid") expect(out.detail).toContain("unexpected")
      // No hidden marker inside any normal result union member.
      const okHandle = peer.privateStatusOutcomeWithHandle(req("/repo"))
      // Keep handle ids distinct and cancellable without throwing.
      expect(typeof okHandle.id).toBe("number")
      expect(() => okHandle.cancel("test")).not.toThrow()
      // Drain the second handle to avoid leaking a pending request.
      try {
        okHandle.cancel("test cleanup")
      } catch (err) {
        noteCleanup("status-handle-cancel", err)
      }
      try {
        await Promise.race([okHandle.promise, Promise.resolve({ kind: "invalid", detail: "cleanup" })])
      } catch (err) {
        noteCleanup("status-handle-drain", err)
      }
    } finally {
      peer.dispose()
      try {
        backend.dispose()
      } catch (err) {
        noteCleanup("backend-dispose", err)
      }
      try {
        toClient.destroy()
      } catch (err) {
        noteCleanup("toClient-destroy", err)
      }
      try {
        toBackend.destroy()
      } catch (err) {
        noteCleanup("toBackend-destroy", err)
      }
    }
  })

  it("detail presence mismatch via production peer is validation divergence, never parity-equal", async () => {
    const warns: string[] = []
    const latch = warnLatch("validation divergence")
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      const msg = String(a[0])
      warns.push(msg)
      latch.onWarn(msg)
    }
    try {
      const r = req()
      const { peer, backend, toClient, toBackend } = await linkedStatusPeer(async (method, params) => {
        if (method === "initialize")
          return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/status"] }
        if (method === "session/status") {
          const q = params as ServePrivateStatusRequest
          return {
            v: 1,
            requestId: q.requestId,
            opId: q.opId,
            op: "session/status",
            idempotencyKey: q.idempotencyKey,
            status: "failed",
            outcome: { type: "failed", time: 1, failure: { code: "internal", message: "x", retryable: false } },
            accepted: false,
            failure: { code: "internal", message: "x", retryable: false, detail: "d" },
          }
        }
        throw new Error("unexpected")
      })
      try {
        // Direct validator rejects presence mismatch.
        const raw = {
          v: 1,
          requestId: r.requestId,
          opId: r.opId,
          op: "session/status",
          idempotencyKey: r.idempotencyKey,
          status: "failed",
          outcome: { type: "failed", time: 1, failure: { code: "internal", message: "x", retryable: false } },
          accepted: false,
          failure: { code: "internal", message: "x", retryable: false, detail: "d" },
        }
        expect(() => validateStatusResult(raw, r)).toThrow()
        expect(normalizePrivateStatusWire(raw, r).kind).toBe("invalid")
        // Public handle rejects; outcome handle resolves invalid. Neither
        // yields a normal result that could reach compareStatusParity.
        let err: unknown
        try {
          await peer.privateStatus(r)
        } catch (e) {
          err = e
        }
        expect(isPrivateStatusValidationError(err)).toBeTrue()
        const probed = await peer.privateStatusOutcomeWithHandle(r).promise
        expect(probed.kind).toBe("invalid")
        // Observer via the normalized handle logs validation divergence and
        // never reaches compareStatusParity (no parity log of any kind); SDK stays authoritative.
        const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
        const map = new Map<string, SessionStatus["type"]>()
        const msgs: unknown[] = []
        const connection = {
          isPrivateAvailable: () => peer.isAvailable(),
          privateStatusWithHandle: (q: ServePrivateStatusRequest) => peer.privateStatusWithHandle(q),
          privateStatus: (q: ServePrivateStatusRequest) => peer.privateStatus(q),
          privateStatusOutcomeWithHandle: (q: ServePrivateStatusRequest) => peer.privateStatusOutcomeWithHandle(q),
        }
        await seedSessionStatuses(client, "/repo", map, (m) => msgs.push(m), true, { connection })
        await latch.promise
        expect(map.get("ses_a")).toBe("busy")
        expect(msgs).toEqual([{ type: "sessionStatus", sessionID: "ses_a", status: "busy" }])
        expect(warns.some((w) => w.includes("validation divergence"))).toBeTrue()
        expect(warns.some((w) => w.includes("parity divergence"))).toBeFalse()
        expect(warns.some((w) => w.includes("transport-unknown parity"))).toBeFalse()
      } finally {
        peer.dispose()
        try {
          backend.dispose()
        } catch (err) {
          noteCleanup("backend-dispose", err)
        }
        try {
          toClient.destroy()
        } catch (err) {
          noteCleanup("toClient-destroy", err)
        }
        try {
          toBackend.destroy()
        } catch (err) {
          noteCleanup("toBackend-destroy", err)
        }
      }
    } finally {
      console.warn = orig
    }
  })

  it("legacy valid result still compares; legacy malformed never compares", async () => {
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    const warns: string[] = []
    const parityLatch = warnLatch("parity divergence")
    const validationLatch = warnLatch("validation divergence")
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      const msg = String(a[0])
      warns.push(msg)
      parityLatch.onWarn(msg)
      validationLatch.onWarn(msg)
    }
    try {
      // Valid legacy handle resolves and compares (divergent map logs parity, SDK untouched).
      const map = new Map<string, SessionStatus["type"]>()
      const msgs: unknown[] = []
      const divergent = {
        isPrivateAvailable: () => true,
        privateStatusWithHandle: (r: ServePrivateStatusRequest) => ({
          id: 1,
          promise: Promise.resolve(okRes(r, { ses_a: { type: "idle" } })),
          cancel: () => true,
        }),
        privateStatus: async () => ({}),
      }
      await seedSessionStatuses(client, "/repo", map, (m) => msgs.push(m), true, { connection: divergent })
      await parityLatch.promise
      expect(map.get("ses_a")).toBe("busy")
      expect(map.get("ses_ghost")).toBeUndefined()
      // Malformed legacy handle resolves raw invalid: observer normalizes to
      // invalid outcome and returns before compare (validation divergence only).
      warns.length = 0
      const malformed = {
        isPrivateAvailable: () => true,
        privateStatusWithHandle: (r: ServePrivateStatusRequest) => ({
          id: 2,
          promise: Promise.resolve({ ...okRes(r, { ses_a: { type: "busy" } }), extra: 1 }),
          cancel: () => true,
        }),
        privateStatus: async () => ({}),
      }
      await seedSessionStatuses(client, "/repo", new Map(), () => {}, true, { connection: malformed })
      await validationLatch.promise
      expect(warns.some((w) => w.includes("validation divergence"))).toBeTrue()
      expect(warns.some((w) => w.includes("parity divergence"))).toBeFalse()
    } finally {
      console.warn = orig
    }
  })

  it("init failure disposes allocated peer/streams before rethrow (LOCK-020)", async () => {
    const origDestroy = PassThrough.prototype.destroy
    let destroys = 0
    PassThrough.prototype.destroy = function (...args: unknown[]) {
      destroys += 1
      return (origDestroy as (...a: unknown[]) => unknown).apply(this, args)
    } as typeof origDestroy
    try {
      let err: unknown
      try {
        await linkedStatusPeer(async (method) => {
          if (method === "initialize") throw new Error("synthetic status init failure")
          throw new Error("unexpected")
        })
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      expect(destroys).toBeGreaterThanOrEqual(2)
    } finally {
      PassThrough.prototype.destroy = origDestroy
    }
  })
})

describe("seed non-blocking parity observation (B5 final blocker)", () => {
  it("seed resolves before a hanging private observer timeout; SDK map/posts applied first", async () => {
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    const map = new Map<string, SessionStatus["type"]>()
    const msgs: unknown[] = []
    let observed = false
    const connection = {
      isPrivateAvailable: () => true,
      privateStatusWithHandle: () => ({
        id: 99,
        promise: new Promise(() => {
          observed = true
        }),
        cancel: () => true,
      }),
      privateStatus: async () => new Promise(() => {}) as Promise<unknown>,
    }
    const start = Date.now()
    await seedSessionStatuses(client, "/repo", map, (m) => msgs.push(m), true, { connection, timeoutMs: 5000 })
    const elapsed = Date.now() - start
    expect(map.get("ses_a")).toBe("busy")
    expect(msgs).toEqual([{ type: "sessionStatus", sessionID: "ses_a", status: "busy" }])
    expect(observed).toBeTrue()
    expect(elapsed).toBeLessThan(1000)
  })

  it("sync throw and async rejection from observer are contained with no unhandled rejection", async () => {
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    const warns: string[] = []
    const latch = warnLatch("[Kilo Status]")
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      const msg = String(a[0])
      warns.push(msg)
      latch.onWarn(msg)
    }
    try {
      const syncThrow = {
        isPrivateAvailable: () => {
          throw new Error("sync boom")
        },
        privateStatusWithHandle: () => ({ id: 1, promise: Promise.resolve({}), cancel: () => true }),
        privateStatus: async () => ({}),
      }
      await seedSessionStatuses(client, "/repo", new Map(), () => {}, true, { connection: syncThrow })
      const rejecting = {
        isPrivateAvailable: () => true,
        privateStatusWithHandle: () => ({ id: 2, promise: Promise.reject(new Error("async boom")), cancel: () => true }),
        privateStatus: async () => {
          throw new Error("unused")
        },
      }
      const map = new Map<string, SessionStatus["type"]>()
      await seedSessionStatuses(client, "/repo", map, () => {}, true, { connection: rejecting })
      expect(map.get("ses_a")).toBe("busy")
      await latch.promise
      expect(warns.length).toBeGreaterThan(0)
    } finally {
      console.warn = orig
    }
  })
})

describe("B0/B2 failure.detail omitted-vs-empty compatibility (B5 rollback)", () => {
  function cancelQueuedReq(): Parameters<typeof validateCancelQueuedResult>[0] {
    return {
      v: 1 as const,
      requestId: "r1",
      opId: "cancelQueued:ses_a:msg_b",
      op: "session/cancelQueued" as const,
      idempotencyKey: "idem1",
      context: { directory: "/tmp", sessionId: "ses_a" },
      payload: { messageId: "msg_b" },
    }
  }

  function cancelQueuedFailed(top: Record<string, unknown>, out: Record<string, unknown>): unknown {
    const r = cancelQueuedReq()
    return {
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: "session/cancelQueued",
      idempotencyKey: r.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "stale", message: "m", retryable: false, ...out } },
      accepted: false,
      failure: { code: "stale", message: "m", retryable: false, ...top },
    }
  }

  function sessionUpdateReq(): Parameters<typeof validateSessionUpdateResult>[0] {
    return {
      v: 1 as const,
      requestId: "r1",
      opId: "sessionUpdate:ses_a",
      op: "session/update" as const,
      idempotencyKey: "idem1",
      context: { directory: "/tmp", sessionId: "ses_a" },
      payload: { title: "hi" },
    }
  }

  function sessionUpdateFailed(top: Record<string, unknown>, out: Record<string, unknown>): unknown {
    const r = sessionUpdateReq()
    return {
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: "session/update",
      idempotencyKey: r.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "stale", message: "m", retryable: false, ...out } },
      accepted: false,
      failure: { code: "stale", message: "m", retryable: false, ...top },
    }
  }

  it("B0 cancelQueued keeps omitted-vs-empty compatibility and still rejects value drift", () => {
    const r = cancelQueuedReq()
    expect(() => validateCancelQueuedResult(cancelQueuedFailed({}, {}), r)).not.toThrow()
    expect(() => validateCancelQueuedResult(cancelQueuedFailed({ detail: "" }, {}), r)).not.toThrow()
    expect(() => validateCancelQueuedResult(cancelQueuedFailed({}, { detail: "" }), r)).not.toThrow()
    expect(() => validateCancelQueuedResult(cancelQueuedFailed({ detail: "" }, { detail: "" }), r)).not.toThrow()
    expect(() => validateCancelQueuedResult(cancelQueuedFailed({ detail: "d" }, { detail: "other" }), r)).toThrow()
    expect(() => validateCancelQueuedResult(cancelQueuedFailed({ detail: "d" }, {}), r)).toThrow()
    expect(() => validateCancelQueuedResult(cancelQueuedFailed({}, { detail: "d" }), r)).toThrow()
  })

  it("B2 session/update keeps omitted-vs-empty compatibility and still rejects value drift", () => {
    const r = sessionUpdateReq()
    expect(() => validateSessionUpdateResult(sessionUpdateFailed({}, {}), r)).not.toThrow()
    expect(() => validateSessionUpdateResult(sessionUpdateFailed({ detail: "" }, {}), r)).not.toThrow()
    expect(() => validateSessionUpdateResult(sessionUpdateFailed({}, { detail: "" }), r)).not.toThrow()
    expect(() => validateSessionUpdateResult(sessionUpdateFailed({ detail: "" }, { detail: "" }), r)).not.toThrow()
    expect(() => validateSessionUpdateResult(sessionUpdateFailed({ detail: "d" }, { detail: "other" }), r)).toThrow()
    expect(() => validateSessionUpdateResult(sessionUpdateFailed({ detail: "d" }, {}), r)).toThrow()
    expect(() => validateSessionUpdateResult(sessionUpdateFailed({}, { detail: "d" }), r)).toThrow()
  })
})

describe("production KiloConnectionService outcome pass-through (B5 root-cause close)", () => {
  async function linkedServicePeer(handler: (method: string, params: unknown) => unknown, epoch = 71) {
    let toClient: PassThrough | undefined
    let toBackend: PassThrough | undefined
    let backend: JsonRpcPeer | undefined
    let peer: ServePrivatePeer | undefined
    try {
      toClient = new PassThrough()
      toBackend = new PassThrough()
      backend = new JsonRpcPeer({ reader: toBackend, writer: toClient, onRequest: handler as never })
      peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 71, epoch, initializeTimeoutMs: 500 })
      expect(await peer.initialize(500)).toBeTrue()
      const svc = new KiloConnectionService({} as never)
      ;(svc as unknown as Record<string, unknown>).privatePeer = peer
      ;(svc as unknown as Record<string, unknown>).privateAvailable = true
      ;(svc as unknown as Record<string, unknown>).privateEpoch = epoch
      const out = {
        peer: peer as ServePrivatePeer,
        backend: backend as JsonRpcPeer,
        toClient: toClient as PassThrough,
        toBackend: toBackend as PassThrough,
        svc,
      }
      backend = undefined
      peer = undefined
      toClient = undefined
      toBackend = undefined
      return out
    } catch (err) {
      if (peer) {
        try {
          peer.dispose()
        } catch (cleanupErr) {
          noteCleanup("peer-dispose", cleanupErr)
        }
      }
      if (backend) {
        try {
          backend.dispose()
        } catch (cleanupErr) {
          noteCleanup("backend-dispose", cleanupErr)
        }
      }
      if (toClient) {
        try {
          toClient.destroy()
        } catch (cleanupErr) {
          noteCleanup("toClient-destroy", cleanupErr)
        }
      }
      if (toBackend) {
        try {
          toBackend.destroy()
        } catch (cleanupErr) {
          noteCleanup("toBackend-destroy", cleanupErr)
        }
      }
      throw err
    }
  }

  function teardown(link: { peer: ServePrivatePeer; backend: JsonRpcPeer; toClient: PassThrough; toBackend: PassThrough }): void {
    link.peer.dispose()
    try {
      link.backend.dispose()
    } catch (err) {
      noteCleanup("backend-dispose", err)
    }
    try {
      link.toClient.destroy()
    } catch (err) {
      noteCleanup("toClient-destroy", err)
    }
    try {
      link.toBackend.destroy()
    } catch (err) {
      noteCleanup("toBackend-destroy", err)
    }
  }

  it("production path prefers outcome API: malformed wire is invalid and bypasses comparator", async () => {
    const warns: string[] = []
    const latch = warnLatch("validation divergence")
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      const msg = String(a[0])
      warns.push(msg)
      latch.onWarn(msg)
    }
    const link = await linkedServicePeer(async (method, params) => {
      if (method === "initialize")
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/status"] }
      if (method === "session/status") {
        const q = params as ServePrivateStatusRequest
        return { ...okRes(q, { ses_a: { type: "busy" } }), extra: 1 }
      }
      throw new Error("unexpected")
    })
    try {
      const r = req()
      expect(typeof link.svc.privateStatusOutcomeWithHandle).toBe("function")
      const out = await link.svc.privateStatusOutcomeWithHandle(r).promise
      expect(out.kind).toBe("invalid")
      // Legacy valid-result API stays compatible: same malformed wire rejects.
      let err: unknown
      try {
        await link.svc.privateStatus(r)
      } catch (e) {
        err = e
      }
      expect(isPrivateStatusValidationError(err)).toBeTrue()
      // Observer through the production service logs validation divergence and
      // never reaches compareStatusParity; SDK stays authoritative.
      const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
      const map = new Map<string, SessionStatus["type"]>()
      const msgs: unknown[] = []
      await seedSessionStatuses(client, "/repo", map, (m) => msgs.push(m), true, {
        connection: link.svc as never,
      })
      await latch.promise
      expect(map.get("ses_a")).toBe("busy")
      expect(msgs).toEqual([{ type: "sessionStatus", sessionID: "ses_a", status: "busy" }])
      expect(warns.some((w) => w.includes("validation divergence"))).toBeTrue()
      expect(warns.some((w) => w.includes("parity divergence"))).toBeFalse()
      expect(warns.some((w) => w.includes("transport-unknown parity"))).toBeFalse()
    } finally {
      console.warn = orig
      teardown(link)
    }
  })

  it("production outcome prefers explicit outcome handle over legacy; valid results still parity-compare", async () => {
    const warns: string[] = []
    const latch = warnLatch("parity divergence")
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      const msg = String(a[0])
      warns.push(msg)
      latch.onWarn(msg)
    }
    const link = await linkedServicePeer(async (method, params) => {
      if (method === "initialize")
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/status"] }
      if (method === "session/status") {
        const q = params as ServePrivateStatusRequest
        return okRes(q, { ses_a: { type: "idle" } })
      }
      throw new Error("unexpected")
    })
    try {
      // If the observer fell back to legacy, this throw would surface as a
      // fail-closed observation; via the outcome handle it must not be called.
      const svc = link.svc
      const legacy = svc.privateStatusWithHandle.bind(svc)
      ;(svc as unknown as Record<string, unknown>).privateStatusWithHandle = () => {
        throw new Error("legacy must not be used when outcome API exists")
      }
      try {
        const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
        const map = new Map<string, SessionStatus["type"]>()
        await seedSessionStatuses(client, "/repo", map, () => {}, true, { connection: svc as never })
        await latch.promise
        expect(map.get("ses_a")).toBe("busy")
        expect(warns.some((w) => w.includes("parity divergence"))).toBeTrue()
      } finally {
        ;(svc as unknown as Record<string, unknown>).privateStatusWithHandle = legacy
      }
    } finally {
      console.warn = orig
      teardown(link)
    }
  })

  it("production outcome keeps epoch fail-closed and exact-cancel ownership", async () => {
    const link = await linkedServicePeer(async (method, params) => {
      if (method === "initialize")
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/status"] }
      if (method === "session/status") {
        const q = params as ServePrivateStatusRequest
        return okRes(q, { ses_a: { type: "busy" } })
      }
      throw new Error("unexpected")
    })
    try {
      // Epoch drift between call and return maps to valid ambiguous.
      const drift = link.svc.privateStatusOutcomeWithHandle(req())
      ;(link.svc as unknown as Record<string, unknown>).privateEpoch = 999
      const drifted = await drift.promise
      expect(drifted.kind).toBe("valid")
      if (drifted.kind === "valid") {
        expect(drifted.result.status).toBe("ambiguous")
        expect((drifted.result as unknown as Record<string, unknown>).transportUnknown).toBeTrue()
      }
    } finally {
      teardown(link)
    }

    const hanging = await linkedServicePeer(
      async (method) => {
        if (method === "initialize")
          return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/status"] }
        if (method === "session/status") return new Promise(() => {})
        throw new Error("unexpected")
      },
      72,
    )
    try {
      const handle = hanging.svc.privateStatusOutcomeWithHandle(req())
      expect(handle.cancel("test")).toBeTrue()
      expect(hanging.svc.isPrivateAvailable()).toBeTrue()
      try {
        handle.cancel("cleanup")
      } catch (err) {
        noteCleanup("status-handle-cancel", err)
      }
      try {
        await Promise.race([handle.promise, Promise.resolve({ kind: "valid" })])
      } catch (err) {
        noteCleanup("status-handle-drain", err)
      }
    } finally {
      teardown(hanging)
    }
  })

  it("service init failure disposes allocated peer/streams before rethrow (LOCK-020)", async () => {
    const origDestroy = PassThrough.prototype.destroy
    let destroys = 0
    PassThrough.prototype.destroy = function (...args: unknown[]) {
      destroys += 1
      return (origDestroy as (...a: unknown[]) => unknown).apply(this, args)
    } as typeof origDestroy
    try {
      let err: unknown
      try {
        await linkedServicePeer(async (method) => {
          if (method === "initialize") throw new Error("synthetic service init failure")
          throw new Error("unexpected")
        })
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      expect(destroys).toBeGreaterThanOrEqual(2)
    } finally {
      PassThrough.prototype.destroy = origDestroy
    }
  })

  it("manual linked allocation cleans every resource when initialize fails (LOCK-020)", async () => {
    let toClient: PassThrough | undefined
    let toBackend: PassThrough | undefined
    let backend: JsonRpcPeer | undefined
    let peer: ServePrivatePeer | undefined
    let failed: unknown
    try {
      toClient = new PassThrough()
      toBackend = new PassThrough()
      backend = new JsonRpcPeer({
        reader: toBackend,
        writer: toClient,
        onRequest: (async () => {
          throw new Error("synthetic manual init failure")
        }) as never,
      })
      peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 95, epoch: 95, initializeTimeoutMs: 200 })
      const ok = await peer.initialize(200)
      if (!ok) failed = new Error("synthetic manual init failure (initialize returned false)")
    } catch (err) {
      failed = err
    }
    if (peer) {
      try {
        peer.dispose()
      } catch (err) {
        noteCleanup("peer-dispose", err)
      }
    }
    if (backend) {
      try {
        backend.dispose()
      } catch (err) {
        noteCleanup("backend-dispose", err)
      }
    }
    if (toClient) {
      try {
        toClient.destroy()
      } catch (err) {
        noteCleanup("toClient-destroy", err)
      }
    }
    if (toBackend) {
      try {
        toBackend.destroy()
      } catch (err) {
        noteCleanup("toBackend-destroy", err)
      }
    }
    expect(failed).toBeDefined()
    expect(toClient?.destroyed).toBeTrue()
    expect(toBackend?.destroyed).toBeTrue()
    if (peer) expect(peer.isAvailable()).toBeFalse()
  })

  it("partial construction rollback destroys first stream when later allocation throws (LOCK-020)", async () => {
    const origDestroy = PassThrough.prototype.destroy
    let destroys = 0
    PassThrough.prototype.destroy = function (...args: unknown[]) {
      destroys += 1
      return (origDestroy as (...a: unknown[]) => unknown).apply(this, args)
    } as typeof origDestroy
    try {
      let toClient: PassThrough | undefined
      let failed: unknown
      try {
        toClient = new PassThrough()
        throw new Error("synthetic second-allocation failure")
      } catch (err) {
        if (toClient) {
          try {
            toClient.destroy()
          } catch (cleanupErr) {
            noteCleanup("toClient-destroy", cleanupErr)
          }
        }
        failed = err
      }
      expect(failed).toBeDefined()
      expect(String((failed as Error).message)).toContain("synthetic second-allocation failure")
      expect(destroys).toBeGreaterThanOrEqual(1)
      expect(toClient?.destroyed).toBeTrue()
    } finally {
      PassThrough.prototype.destroy = origDestroy
    }
  })
})

describe("stale observer timeout epoch ownership (LOCK-007)", () => {
  function statusFake(overrides: Record<string, unknown> = {}): Record<string, unknown> & {
    isAvailable: () => boolean
    hasCapability: () => boolean
  } {
    const base = {
      isAvailable: () => true,
      hasCapability: () => true,
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
      privateStatusOutcomeWithHandle: (r: ServePrivateStatusRequest) => ({
        id: 1,
        promise: Promise.resolve({ kind: "valid", result: okRes(r, {}) }),
        cancel: () => true,
      }),
      ...overrides,
    } as Record<string, unknown> & { isAvailable: () => boolean; hasCapability: () => boolean }
    return base
  }

  it("stale captured handle cleans only its peer and never invalidates the replacement", async () => {
    const svc = new KiloConnectionService({} as never)
    const anySvc = svc as unknown as {
      privatePeer: unknown
      privateAvailable: boolean
      privateEpoch: number | null
    }
    const release = deferred<ServePrivateStatusResult>()
    let oldInvalidated = false
    let newInvalidated = false
    const oldFake = statusFake({
      privateStatusOutcomeWithHandle: () => ({ id: 41, promise: release.promise, cancel: () => true }),
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {
        oldInvalidated = true
      },
    })
    anySvc.privatePeer = oldFake
    anySvc.privateAvailable = true
    anySvc.privateEpoch = 9
    const r = req()
    const handle = svc.privateStatusOutcomeWithHandle(r)
    const newFake = statusFake({
      invalidateOnObserverTimeout: () => {
        newInvalidated = true
      },
    })
    anySvc.privatePeer = newFake
    anySvc.privateEpoch = 10
    const result = handle.cancel("private parity timeout")
    expect(result).toBe("stale")
    expect(svc.isPrivateAvailable()).toBeTrue()
    expect(svc.getPrivateEpoch()).toBe(10)
    expect(oldInvalidated).toBeTrue()
    expect(newInvalidated).toBeFalse()
    release.resolve(okRes(r, { ses_a: { type: "busy" } }))
    const settled = await handle.promise
    expect(settled.kind).toBe("valid")
    if (settled.kind === "valid") {
      expect(settled.result.status).toBe("ambiguous")
      expect((settled.result as unknown as Record<string, unknown>).transportUnknown).toBeTrue()
    }
  })

  it("current-epoch cancel miss still fail-closed invalidates", async () => {
    const svc = new KiloConnectionService({} as never)
    const anySvc = svc as unknown as {
      privatePeer: unknown
      privateAvailable: boolean
      privateEpoch: number | null
    }
    const fake = statusFake({
      privateStatusOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: () => true,
      }),
      tryCancelPending: () => false,
    })
    anySvc.privatePeer = fake
    anySvc.privateAvailable = true
    anySvc.privateEpoch = 9
    const handle = svc.privateStatusOutcomeWithHandle(req())
    const result = handle.cancel("private parity timeout")
    expect(result).toBe(false)
    expect(svc.isPrivateAvailable()).toBeFalse()
    expect(svc.getPrivatePeer()).toBeNull()
  })

  it("stale cleanup throw is observed without touching the replacement peer", async () => {
    const svc = new KiloConnectionService({} as never)
    const anySvc = svc as unknown as {
      privatePeer: unknown
      privateAvailable: boolean
      privateEpoch: number | null
    }
    const release = deferred<ServePrivateStatusResult>()
    let newInvalidated = false
    const oldFake = statusFake({
      privateStatusOutcomeWithHandle: () => ({ id: 51, promise: release.promise, cancel: () => true }),
      invalidateOnObserverTimeout: () => {
        throw new Error("stale cleanup boom")
      },
    })
    anySvc.privatePeer = oldFake
    anySvc.privateAvailable = true
    anySvc.privateEpoch = 9
    const r = req()
    const handle = svc.privateStatusOutcomeWithHandle(r)
    const newFake = statusFake({
      invalidateOnObserverTimeout: () => {
        newInvalidated = true
      },
    })
    anySvc.privatePeer = newFake
    anySvc.privateEpoch = 10
    const warns: string[] = []
    const latch = warnLatch("stale observer cleanup failed")
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      const msg = String(a[0])
      warns.push(msg)
      latch.onWarn(msg)
    }
    try {
      const result = handle.cancel("private parity timeout")
      await latch.promise
      expect(result).toBe("stale")
      expect(svc.isPrivateAvailable()).toBeTrue()
      expect(svc.getPrivateEpoch()).toBe(10)
      expect(newInvalidated).toBeFalse()
      expect(warns.some((w) => w.includes("stale observer cleanup failed"))).toBeTrue()
    } finally {
      console.warn = orig
    }
    release.resolve(okRes(r, {}))
    const settled = await handle.promise
    expect(settled.kind).toBe("valid")
  })

  it("current-epoch cancel throw is observed and still fail-closed invalidates", async () => {
    const svc = new KiloConnectionService({} as never)
    const anySvc = svc as unknown as {
      privatePeer: unknown
      privateAvailable: boolean
      privateEpoch: number | null
    }
    const fake = statusFake({
      privateStatusOutcomeWithHandle: () => ({ id: 52, promise: new Promise(() => {}), cancel: () => true }),
      tryCancelPending: () => {
        throw new Error("cancel boom")
      },
    })
    anySvc.privatePeer = fake
    anySvc.privateAvailable = true
    anySvc.privateEpoch = 9
    const handle = svc.privateStatusOutcomeWithHandle(req())
    const warns: string[] = []
    const latch = warnLatch("observer timeout cancel failed")
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      const msg = String(a[0])
      warns.push(msg)
      latch.onWarn(msg)
    }
    try {
      const result = handle.cancel("private parity timeout")
      await latch.promise
      expect(result).toBe(false)
      expect(svc.isPrivateAvailable()).toBeFalse()
      expect(svc.getPrivatePeer()).toBeNull()
      expect(warns.some((w) => w.includes("observer timeout cancel failed"))).toBeTrue()
    } finally {
      console.warn = orig
    }
  })

  it("observer with stale outcome cancel never invalidates replacement peer", async () => {
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    const cancelled = deferred<unknown>()
    let invalidated = 0
    let epoch: number | null = 9
    const connection = {
      isPrivateAvailable: () => true,
      privateStatusOutcomeWithHandle: () => ({
        id: 43,
        promise: new Promise(() => {}),
        cancel: () => {
          cancelled.resolve("stale")
          return "stale" as const
        },
      }),
      privateStatusWithHandle: () => {
        throw new Error("legacy must not be used when outcome API exists")
      },
      privateStatus: async () => new Promise(() => {}),
      getPrivateEpoch: () => epoch,
      invalidatePrivatePeerOnObserverTimeout: () => {
        invalidated += 1
      },
    }
    const pending = seedSessionStatuses(client, "/repo", new Map(), () => {}, true, {
      connection,
      timeoutMs: 50,
    })
    await pending
    epoch = 10
    await withDeadline(cancelled.promise, 2000, "stale observer cancel")
    await Promise.resolve()
    await Promise.resolve()
    expect(invalidated).toBe(0)
  })

  it("observer legacy epoch drift never invalidates replacement peer", async () => {
    const client = sdkClient({ ses_a: { type: "busy" } as SessionStatus })
    const cancelled = deferred<boolean>()
    let invalidated = 0
    let epoch: number | null = 9
    const connection = {
      isPrivateAvailable: () => true,
      privateStatusWithHandle: () => ({
        id: 44,
        promise: new Promise(() => {}),
        cancel: () => {
          cancelled.resolve(false)
          return false
        },
      }),
      privateStatus: async () => new Promise(() => {}),
      getPrivateEpoch: () => epoch,
      invalidatePrivatePeerOnObserverTimeout: () => {
        invalidated += 1
      },
    }
    const pending = seedSessionStatuses(client, "/repo", new Map(), () => {}, true, {
      connection,
      timeoutMs: 50,
    })
    await pending
    epoch = 10
    await withDeadline(cancelled.promise, 2000, "legacy drift cancel")
    await Promise.resolve()
    await Promise.resolve()
    expect(invalidated).toBe(0)
  })
})

describe("B5 strict omitted-vs-empty rejection (B5 rollback remainder)", () => {
  it("B5 status keeps strict omitted-vs-empty rejection", () => {
    const r = req()
    const strict = (top: Record<string, unknown>, out: Record<string, unknown>): unknown => ({
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: "session/status",
      idempotencyKey: r.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "internal", message: "x", retryable: false, ...out } },
      accepted: false,
      failure: { code: "internal", message: "x", retryable: false, ...top },
    })
    expect(() => validateStatusResult(strict({ detail: "" }, {}), r)).toThrow()
    expect(() => validateStatusResult(strict({}, { detail: "" }), r)).toThrow()
  })
})
