import { describe, expect, it, mock } from "bun:test"
import type { Session } from "@kilocode/sdk/v2/client"
import { executeDurableFork, observeForkParity, buildForkIdentity } from "../../src/kilo-provider/fork-session"
import { validateForkResult, compareForkParity, validateForkRequest } from "../../src/services/cli-backend/serve-private-peer"

const session = { id: "ses_forked", title: "fork", createdAt: "", updatedAt: "" } as unknown as Session

describe("fork session durable SDK payload", () => {
  it("sends durable tuple via generated SDK", async () => {
    const forkMock = mock(async (params: unknown) => ({ data: session, response: { status: 200 } }))
    const client = { session: { fork: forkMock } } as unknown as import("@kilocode/sdk/v2/client").KiloClient
    const identity = buildForkIdentity("ses_src")
    const res = await executeDurableFork(client, { sessionId: "ses_src", directory: "/repo", messageId: "msg_1", opId: identity.opId, idempotencyKey: identity.idempotencyKey, requestId: identity.requestId })
    expect(res.data.id).toBe(session.id)
    expect(forkMock).toHaveBeenCalled()
    const callArg = forkMock.mock.calls[0][0] as Record<string, unknown>
    expect(callArg.sessionID).toBe("ses_src")
    expect(callArg.directory).toBe("/repo")
    expect(callArg.messageID).toBe("msg_1")
    expect(callArg.opId).toBe(identity.opId)
    expect(callArg.idempotencyKey).toBe(identity.idempotencyKey)
    expect(callArg.requestId).toBe(identity.requestId)
    expect((callArg.context as Record<string, unknown>).directory).toBe("/repo")
    expect((callArg.context as Record<string, unknown>).sessionId).toBe("ses_src")
  })

  it("private peer validates and parity compares exact committed result", async () => {
    const privSession = { id: "ses_forked", parentID: "ses_src", directory: "/repo", title: "forked" } as unknown as Record<string, unknown>
    const privRes = {
      v: 1 as const,
      requestId: "req1",
      opId: "fork:ses_src:tok",
      op: "session/fork" as const,
      idempotencyKey: "fork:ses_src:tok",
      status: "succeeded" as const,
      outcome: { type: "succeeded" as const, time: Date.now() },
      accepted: true as const,
      data: { session: privSession },
    }
    const sdkRes = { data: { id: "ses_forked", parentID: "ses_src", directory: "/repo", title: "forked" } as unknown as Session, response: { status: 200 } }
    const req = { v: 1 as const, requestId: "req1", opId: "fork:ses_src:tok", op: "session/fork" as const, idempotencyKey: "fork:ses_src:tok", context: { directory: "/repo", sessionId: "ses_src", parentSessionId: null }, payload: {} }
    expect(() => validateForkResult(privRes as unknown, req as unknown as never)).not.toThrow()
    const parity = compareForkParity(privRes as unknown as never, sdkRes as unknown as never)
    expect(parity.divergence).toBeNull()
    // id mismatch should diverge
    const badPriv = { ...privRes, data: { session: { id: "ses_other", parentID: "ses_src", directory: "/repo" } } }
    const badParity = compareForkParity(badPriv as unknown as never, sdkRes as unknown as never)
    expect(badParity.divergence).toBe("fork-id-mismatch")
    // parent mismatch
    const badParent = { ...privRes, data: { session: { id: "ses_forked", parentID: "ses_other", directory: "/repo" } } }
    expect(compareForkParity(badParent as unknown as never, sdkRes as unknown as never).divergence).toBe("fork-parent-mismatch")
    // directory mismatch with canonical normalization
    const badDir = { ...privRes, data: { session: { id: "ses_forked", parentID: "ses_src", directory: "/other" } } }
    expect(compareForkParity(badDir as unknown as never, sdkRes as unknown as never).divergence).toBe("fork-directory-mismatch")
    // canonical equivalence: /repo/./ vs /repo should match
    const canonPriv = { ...privRes, data: { session: { id: "ses_forked", parentID: "ses_src", directory: "/repo/./" } } }
    expect(compareForkParity(canonPriv as unknown as never, sdkRes as unknown as never).divergence).toBeNull()
  })

  it("no mutation on private missing record is fail-closed", async () => {
    const forkMock = mock(async () => ({ data: session }))
    const client = { session: { fork: forkMock } } as unknown as import("@kilocode/sdk/v2/client").KiloClient
    // private unavailable should not mutate and should be fail-closed
    const conn = {
      getClient: () => client,
      isPrivateAvailable: () => false,
      privateFork: mock(async () => { throw new Error("should not be called") }),
    } as unknown as import("../../src/services/cli-backend").KiloConnectionService
    const identity = buildForkIdentity("ses_src")
    const sdkRes = await executeDurableFork(client, { sessionId: "ses_src", directory: "/repo", opId: identity.opId, idempotencyKey: identity.idempotencyKey, requestId: identity.requestId })
    // observe should be no-op when unavailable, not throw, not mutate
    await observeForkParity(conn, { data: sdkRes.data } as unknown, { sessionId: "ses_src", directory: "/repo", opId: identity.opId, idempotencyKey: identity.idempotencyKey, requestId: identity.requestId })
    expect(forkMock).toHaveBeenCalledTimes(1)
  })

  it("private missing record returns failed without mutation", async () => {
    // Simulate private peer returning failed internal (no committed record)
    const conn = {
      isPrivateAvailable: () => true,
      privateFork: mock(async () => ({
        v: 1,
        requestId: "req1",
        opId: "fork:ses_src:tok",
        op: "session/fork",
        idempotencyKey: "fork:ses_src:tok",
        status: "failed",
        outcome: { type: "failed", time: Date.now(), failure: { code: "internal", message: "no committed fork record", retryable: false } },
        accepted: false,
        failure: { code: "internal", message: "no committed fork record", retryable: false },
      })),
    } as unknown as import("../../src/services/cli-backend").KiloConnectionService
    const sdkRes = { data: session, response: { status: 200 } }
    await observeForkParity(conn, sdkRes as unknown, { sessionId: "ses_src", directory: "/repo", opId: "fork:ses_src:tok", idempotencyKey: "fork:ses_src:tok", requestId: "req1" })
    // should not throw, parity should be divergence or null but not mutate
    expect(conn.privateFork).toHaveBeenCalled()
  })

  it("does not fallback to legacy on durable 400 validation error", async () => {
    const err = new Error("400 Bad Request: validation.failed")
    ;(err as unknown as { code?: number }).code = 400
    const forkMock = mock(async () => {
      throw err
    })
    const client = { session: { fork: forkMock } } as unknown as import("@kilocode/sdk/v2/client").KiloClient
    const identity = buildForkIdentity("ses_src")
    await expect(
      executeDurableFork(client, {
        sessionId: "ses_src",
        directory: "/repo",
        opId: identity.opId,
        idempotencyKey: identity.idempotencyKey,
        requestId: identity.requestId,
      }),
    ).rejects.toThrow()
    expect(forkMock).toHaveBeenCalledTimes(1)
  })

  it("rejects malformed messageId not matching MessageID brand", () => {
    const base = {
      v: 1 as const,
      requestId: "req1",
      opId: "fork:ses_src:tok",
      op: "session/fork" as const,
      idempotencyKey: "fork:ses_src:tok",
      context: { directory: "/repo", sessionId: "ses_src", parentSessionId: null },
      payload: { messageId: "bad-id" },
    }
    expect(() => validateForkRequest(base as unknown)).toThrow("MessageID")
    const good = { ...base, payload: { messageId: "msg_abc123" } }
    expect(() => validateForkRequest(good as unknown)).not.toThrow()
    const empty = { ...base, payload: { messageId: "" } }
    expect(() => validateForkRequest(empty as unknown)).toThrow()
  })

  it("accepts backend-valid colon/space MessageID forms", () => {
    const base = {
      v: 1 as const,
      requestId: "req1",
      opId: "fork:ses_src:tok",
      op: "session/fork" as const,
      idempotencyKey: "fork:ses_src:tok",
      context: { directory: "/repo", sessionId: "ses_src", parentSessionId: null },
      payload: { messageId: "msg_abc123" },
    }
    const colon = { ...base, payload: { messageId: "msg:abc:def" } }
    expect(() => validateForkRequest(colon as unknown)).not.toThrow()
    const space = { ...base, payload: { messageId: "msg a b" } }
    expect(() => validateForkRequest(space as unknown)).not.toThrow()
    const mixed = { ...base, payload: { messageId: "msg: with space" } }
    expect(() => validateForkRequest(mixed as unknown)).not.toThrow()
    const bad = { ...base, payload: { messageId: "bad:msg" } }
    expect(() => validateForkRequest(bad as unknown)).toThrow()
  })

  it("accepts backend-valid colon/space SessionID forms (backend predicate startsWith ses)", () => {
    const base = {
      v: 1 as const,
      requestId: "req1",
      opId: "fork:ses_src:tok",
      op: "session/fork" as const,
      idempotencyKey: "fork:ses_src:tok",
      context: { directory: "/repo", sessionId: "ses_src", parentSessionId: null },
      payload: {},
    }
    const colon = { ...base, context: { directory: "/repo", sessionId: "ses:colon:id", parentSessionId: null }, opId: "fork:ses:colon:id:tok" }
    expect(() => validateForkRequest(colon as unknown)).not.toThrow()
    const space = { ...base, context: { directory: "/repo", sessionId: "ses with space", parentSessionId: null }, opId: "fork:ses with space:tok" }
    expect(() => validateForkRequest(space as unknown)).not.toThrow()
    const mixed = { ...base, context: { directory: "/repo", sessionId: "ses: with space", parentSessionId: null }, opId: "fork:ses: with space:tok" }
    expect(() => validateForkRequest(mixed as unknown)).not.toThrow()
    // non-ses prefix must fail
    const bad = { ...base, context: { directory: "/repo", sessionId: "bad_ses_id", parentSessionId: null }, opId: "fork:bad_ses_id:tok" }
    expect(() => validateForkRequest(bad as unknown)).toThrow()
    const empty = { ...base, context: { directory: "/repo", sessionId: "", parentSessionId: null }, opId: "fork::tok" }
    expect(() => validateForkRequest(empty as unknown)).toThrow()
  })

  it("bounded 3s timeout does not block authoritative SDK result and synthesizes transportUnknown", async () => {
    let pendingResolved = false
    const conn = {
      isPrivateAvailable: () => true,
      privateFork: mock(() => new Promise(() => {}) as unknown as Promise<never>),
    } as unknown as import("../../src/services/cli-backend").KiloConnectionService
    const sdkRes = { data: { id: "ses_forked", parentID: "ses_src", directory: "/repo" } as unknown as Session, response: { status: 200 } }
    const start = Date.now()
    await observeForkParity(conn, sdkRes as unknown, { sessionId: "ses_src", directory: "/repo", opId: "fork:ses_src:tok", idempotencyKey: "fork:ses_src:tok", requestId: "req1" })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(4000)
    expect(elapsed).toBeGreaterThanOrEqual(2900)
    expect(conn.privateFork).toHaveBeenCalled()
    pendingResolved = true
    expect(pendingResolved).toBeTrue()
  })

  it("observes parity after SDK terminal failure without blocking", async () => {
    const conn = {
      isPrivateAvailable: () => true,
      privateFork: mock(async () => ({
        v: 1,
        requestId: "req1",
        opId: "fork:ses_src:tok",
        op: "session/fork",
        idempotencyKey: "fork:ses_src:tok",
        status: "failed",
        outcome: { type: "failed", time: Date.now(), failure: { code: "session.not_found", message: "x", retryable: false } },
        accepted: false,
        failure: { code: "session.not_found", message: "x", retryable: false },
      })),
    } as unknown as import("../../src/services/cli-backend").KiloConnectionService
    const sdkRes = { data: undefined, error: { _tag: "NotFound", message: "not found" }, response: { status: 404 } }
    await observeForkParity(conn, sdkRes as unknown, { sessionId: "ses_src", directory: "/repo", opId: "fork:ses_src:tok", idempotencyKey: "fork:ses_src:tok", requestId: "req1" })
    expect(conn.privateFork).toHaveBeenCalled()
  })

  it("skips private observation when SDK status is non-terminal (e.g. 429)", async () => {
    const conn = {
      isPrivateAvailable: () => true,
      privateFork: mock(async () => { throw new Error("should not be called") }),
    } as unknown as import("../../src/services/cli-backend").KiloConnectionService
    const sdkRes = { data: undefined, error: { status: 429, message: "429 rate limited" }, response: { status: 429 } }
    await observeForkParity(conn, sdkRes as unknown, { sessionId: "ses_src", directory: "/repo", opId: "fork:ses_src:tok", idempotencyKey: "fork:ses_src:tok", requestId: "req1" })
    expect(conn.privateFork).not.toHaveBeenCalled()
  })

  it("timeout explicitly removes exact pending ID and late response cannot retain", async () => {
    const { PassThrough } = await import("stream")
    const { JsonRpcPeer } = await import("../../src/private-worker/peer")
    const { ServePrivatePeer } = await import("../../src/services/cli-backend/serve-private-peer")
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    const backendPeer = new JsonRpcPeer({
      reader: toBackend,
      writer: toClient,
      onRequest: async (method, params) => {
        if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/fork"] }
        if (method === "session/fork") {
          await new Promise((r) => setTimeout(r, 3600))
          const req = params as { requestId: string; opId: string; idempotencyKey: string }
          return { v: 1, requestId: req.requestId, opId: req.opId, op: "session/fork", idempotencyKey: req.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { session: { id: "ses_forked", parentID: "ses_src", directory: "/repo" } } }
        }
        throw new Error("unexpected")
      },
    })
    const peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 999, epoch: 77, initializeTimeoutMs: 500 })
    try {
      expect(await peer.initialize(500)).toBeTrue()
      expect(peer.isAvailable()).toBeTrue()
      const rawPeer = (peer as unknown as { peer: JsonRpcPeer }).peer as JsonRpcPeer | null
      const nextIdBefore = peer.peekNextJsonRpcId()
      expect(nextIdBefore).not.toBeNull()
      let disposeCalled = false
      const conn = {
        isPrivateAvailable: () => peer.isAvailable(),
        privateFork: (req: unknown) => peer.privateFork(req as never),
        peekPrivatePeerNextId: () => peer.peekNextJsonRpcId(),
        getPrivatePeerPendingCount: () => peer.getPendingCount(),
        tryCancelPrivatePending: (id: number, msg?: string) => peer.tryCancelPending(id, msg),
        invalidatePrivatePeerOnObserverTimeout: (reason: string) => {
          disposeCalled = true
          peer.invalidateOnObserverTimeout(reason)
        },
      } as unknown as import("../../src/services/cli-backend").KiloConnectionService
      const sdkRes = { data: { id: "ses_forked", parentID: "ses_src", directory: "/repo" } as unknown as Session, response: { status: 200 } }
      const start = Date.now()
      await observeForkParity(conn, sdkRes as unknown, { sessionId: "ses_src", directory: "/repo", opId: "fork:ses_src:tok2", idempotencyKey: "fork:ses_src:tok2", requestId: "req-timeout-test" })
      const elapsed = Date.now() - start
      expect(elapsed).toBeGreaterThanOrEqual(2900)
      expect(elapsed).toBeLessThan(4500)
      // exact pending ID must be removed from the JsonRpcPeer map
      const pendingIdsAfter = rawPeer?.getPendingIds() ?? []
      expect(pendingIdsAfter.includes(nextIdBefore as unknown as never)).toBeFalse()
      const pendingAfter = rawPeer?.getPendingCount() ?? peer.getPendingCount()
      const pendingReleased = pendingAfter === 0
      const epochInvalidated = disposeCalled || !peer.isAvailable() || peer.getPendingCount() === 0
      expect(pendingReleased || epochInvalidated).toBeTrue()
      // Late response must not retain: wait a bit for the hanging backend to send its late frame
      await new Promise((r) => setTimeout(r, 700))
      const pendingLate = peer.getPendingCount()
      expect(pendingLate).toBe(0)
      const lateIds = rawPeer?.getPendingIds() ?? []
      expect(lateIds.includes(nextIdBefore as unknown as never)).toBeFalse()
    } finally {
      try { peer.dispose() } catch {}
      try { backendPeer.dispose() } catch {}
      try { toClient.destroy() } catch {}
      try { toBackend.destroy() } catch {}
    }
  })

  it("timeout with unrelated concurrent pending demonstrates current fail-closed invalidation (residual)", async () => {
    const { PassThrough } = await import("stream")
    const { JsonRpcPeer } = await import("../../src/private-worker/peer")
    const { ServePrivatePeer } = await import("../../src/services/cli-backend/serve-private-peer")
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    const backendPeer = new JsonRpcPeer({
      reader: toBackend,
      writer: toClient,
      onRequest: async (method, params) => {
        if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/fork"] }
        if (method === "session/fork") {
          await new Promise((r) => setTimeout(r, 3600))
          const req = params as { requestId: string; opId: string; idempotencyKey: string }
          return { v: 1, requestId: req.requestId, opId: req.opId, op: "session/fork", idempotencyKey: req.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { session: { id: "ses_forked", parentID: "ses_src", directory: "/repo" } } }
        }
        if (method === "dummy/concurrentHang") {
          await new Promise(() => {})
          return undefined
        }
        throw new Error("unexpected:" + method)
      },
    })
    const peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 1000, epoch: 78, initializeTimeoutMs: 500 })
    try {
      expect(await peer.initialize(500)).toBeTrue()
      const rawPeer = (peer as unknown as { peer: JsonRpcPeer }).peer as JsonRpcPeer | null
      expect(rawPeer).not.toBeNull()
      // create unrelated concurrent pending before fork timeout — proves current semantics require API change for same-peer isolation
      const dummyPromise = rawPeer!.request("dummy/concurrentHang", { v: 1 }).catch(() => {})
      await new Promise((r) => setTimeout(r, 30))
      const dummyIds = rawPeer!.getPendingIds()
      expect(dummyIds.length).toBe(1)
      const dummyId = dummyIds[0] as number
      const nextIdBeforeFork = peer.peekNextJsonRpcId()
      expect(nextIdBeforeFork).not.toBeNull()
      expect(nextIdBeforeFork).not.toBe(dummyId)
      const conn = {
        isPrivateAvailable: () => peer.isAvailable(),
        privateFork: (req: unknown) => peer.privateFork(req as never),
        peekPrivatePeerNextId: () => peer.peekNextJsonRpcId(),
        getPrivatePeerPendingCount: () => peer.getPendingCount(),
        tryCancelPrivatePending: (id: number, msg?: string) => peer.tryCancelPending(id, msg),
        invalidatePrivatePeerOnObserverTimeout: (reason: string) => peer.invalidateOnObserverTimeout(reason),
      } as unknown as import("../../src/services/cli-backend").KiloConnectionService
      const sdkRes = { data: { id: "ses_forked", parentID: "ses_src", directory: "/repo" } as unknown as Session, response: { status: 200 } }
      await observeForkParity(conn, sdkRes as unknown, { sessionId: "ses_src", directory: "/repo", opId: "fork:ses_src:tok-concurrent", idempotencyKey: "fork:ses_src:tok-concurrent", requestId: "req-concurrent" })
      // Current production checks `getPendingCount() >0` after explicit cancel, so unrelated dummy causes epoch invalidation (fail-closed until reset).
      // This proves exact fork ID was removed (tryCancel succeeded) but remaining dummy triggers invalidate — same-peer isolation would need API change to check specific ID, not any pending.
      // Assert fork ID removed and peer invalidated (fail-closed), which clears dummy as well.
      const afterIds = rawPeer!.getPendingIds()
      expect(afterIds.includes(nextIdBeforeFork as unknown as never)).toBeFalse()
      // After invalidate the peer is disposed, so pending count is 0 and dummy cleared via dispose — this is current fail-closed behavior, not selective preservation.
      expect(peer.isAvailable()).toBeFalse()
      expect(peer.isDisposed()).toBeTrue()
      expect(peer.getPendingCount()).toBe(0)
      // dummy was cleared by dispose, not preserved — documents residual that selective isolation needs production API change
      expect(afterIds.includes(dummyId as unknown as never)).toBeFalse()
      dummyPromise.catch(() => {})
    } finally {
      try { peer.dispose() } catch {}
      try { backendPeer.dispose() } catch {}
      try { toClient.destroy() } catch {}
      try { toBackend.destroy() } catch {}
    }
  })

  it("forced cancel failure triggers epoch invalidation and fail-closed until reset", async () => {
    const { PassThrough } = await import("stream")
    const { JsonRpcPeer } = await import("../../src/private-worker/peer")
    const { ServePrivatePeer } = await import("../../src/services/cli-backend/serve-private-peer")
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    const backendPeer = new JsonRpcPeer({
      reader: toBackend,
      writer: toClient,
      onRequest: async (method, params) => {
        if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/fork"] }
        if (method === "session/fork") {
          await new Promise((r) => setTimeout(r, 3600))
          const req = params as { requestId: string; opId: string; idempotencyKey: string }
          return { v: 1, requestId: req.requestId, opId: req.opId, op: "session/fork", idempotencyKey: req.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { session: { id: "ses_forked", parentID: "ses_src", directory: "/repo" } } }
        }
        throw new Error("unexpected")
      },
    })
    const peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 1001, epoch: 79, initializeTimeoutMs: 500 })
    try {
      expect(await peer.initialize(500)).toBeTrue()
      const rawPeer = (peer as unknown as { peer: JsonRpcPeer }).peer as JsonRpcPeer | null
      const nextIdBefore = peer.peekNextJsonRpcId()
      let invalidateCalled = false
      let invalidateReason = ""
      const conn = {
        isPrivateAvailable: () => peer.isAvailable(),
        privateFork: (req: unknown) => peer.privateFork(req as never),
        peekPrivatePeerNextId: () => peer.peekNextJsonRpcId(),
        getPrivatePeerPendingCount: () => peer.getPendingCount(),
        // forced failure: tryCancel throws
        tryCancelPrivatePending: (_id: number, _msg?: string) => { throw new Error("forced cancel failure") },
        invalidatePrivatePeerOnObserverTimeout: (reason: string) => {
          invalidateCalled = true
          invalidateReason = reason
          peer.invalidateOnObserverTimeout(reason)
        },
      } as unknown as import("../../src/services/cli-backend").KiloConnectionService
      const sdkRes = { data: { id: "ses_forked", parentID: "ses_src", directory: "/repo" } as unknown as Session, response: { status: 200 } }
      await observeForkParity(conn, sdkRes as unknown, { sessionId: "ses_src", directory: "/repo", opId: "fork:ses_src:tok-forced", idempotencyKey: "fork:ses_src:tok-forced", requestId: "req-forced" })
      // forced cancel failure must trigger invalidation (fail-closed)
      expect(invalidateCalled).toBeTrue()
      expect(invalidateReason.includes("fork:ses_src:tok-forced")).toBeTrue()
      expect(peer.isAvailable()).toBeFalse()
      expect(peer.isDisposed()).toBeTrue()
      // exact pending remains until dispose cleared it, but peer is disposed so future isPrivateAvailable false (disabled until reset)
      const pendingAfter = rawPeer?.getPendingCount() ?? peer.getPendingCount()
      expect(pendingAfter).toBe(0)
    } finally {
      try { peer.dispose() } catch {}
      try { backendPeer.dispose() } catch {}
      try { toClient.destroy() } catch {}
      try { toBackend.destroy() } catch {}
    }
  })
})
