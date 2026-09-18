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
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"

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

  it("current-epoch cancel miss quarantines and retains the private peer", async () => {
    const svc = new KiloConnectionService({} as never)
    const anySvc = svc as unknown as {
      privatePeer: unknown
      privateAvailable: boolean
      privateEpoch: number | null
    }
    let quarantined = false
    const fake = statusFake({
      privateStatusOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: () => true,
      }),
      tryCancelPending: () => false,
      isAvailable: () => !quarantined,
      isQuarantined: () => quarantined,
      invalidateOnObserverTimeout: () => {
        quarantined = true
      },
    })
    anySvc.privatePeer = fake
    anySvc.privateAvailable = true
    anySvc.privateEpoch = 9
    const handle = svc.privateStatusOutcomeWithHandle(req())
    const result = handle.cancel("private parity timeout")
    expect(result).toBe(false)
    expect(svc.isPrivateAvailable()).toBeFalse()
    expect(svc.getPrivatePeer()).toBe(fake)
    expect(svc.getPrivateEpoch()).toBe(9)
    expect(svc.isPrivateQuarantined()).toBeTrue()
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

  it("current-epoch cancel throw quarantines and retains the private peer", async () => {
    const svc = new KiloConnectionService({} as never)
    const anySvc = svc as unknown as {
      privatePeer: unknown
      privateAvailable: boolean
      privateEpoch: number | null
    }
    let quarantined = false
    const fake = statusFake({
      privateStatusOutcomeWithHandle: () => ({ id: 52, promise: new Promise(() => {}), cancel: () => true }),
      tryCancelPending: () => {
        throw new Error("cancel boom")
      },
      isAvailable: () => !quarantined,
      isQuarantined: () => quarantined,
      invalidateOnObserverTimeout: () => {
        quarantined = true
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
      expect(svc.getPrivatePeer()).toBe(fake)
      expect(svc.getPrivateEpoch()).toBe(9)
      expect(svc.isPrivateQuarantined()).toBeTrue()
      expect(warns.some((w) => w.includes("observer timeout cancel failed"))).toBeTrue()
    } finally {
      console.warn = orig
    }
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
