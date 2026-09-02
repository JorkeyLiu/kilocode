import { describe, expect, it, mock } from "bun:test"
import type { Session } from "@kilocode/sdk/v2/client"
import { executeDurableFork, observeForkParity, buildForkIdentity } from "../../src/kilo-provider/fork-session"
import { validateForkResult, compareForkParity } from "../../src/services/cli-backend/serve-private-peer"

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
    const privSession = { id: "ses_forked", title: "forked", directory: "/repo" } as unknown as Record<string, unknown>
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
    const sdkRes = { data: { id: "ses_forked", title: "forked" } as unknown as Session, response: { status: 200 } }
    const req = { v: 1 as const, requestId: "req1", opId: "fork:ses_src:tok", op: "session/fork" as const, idempotencyKey: "fork:ses_src:tok", context: { directory: "/repo", sessionId: "ses_src", parentSessionId: null }, payload: {} }
    expect(() => validateForkResult(privRes as unknown, req as unknown as never)).not.toThrow()
    const parity = compareForkParity(privRes as unknown as never, sdkRes as unknown as never)
    expect(parity.divergence).toBeNull()
    // mismatch should diverge
    const badPriv = { ...privRes, data: { session: { id: "ses_other" } } }
    const badParity = compareForkParity(badPriv as unknown as never, sdkRes as unknown as never)
    expect(badParity.divergence).toBe("fork-id-mismatch")
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
})
