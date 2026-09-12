import { describe, expect, it, mock } from "bun:test"
import type { Session } from "@kilocode/sdk/v2/client"
import { handleForkSession, type ForkContext } from "../../src/kilo-provider/fork-session"

const forkedSession = { id: "ses_forked", parentID: "ses_src", directory: "/repo", title: "forked" } as unknown as Session

function okPrivate(statuses: Record<string, unknown>) {
  return {
    isPrivateAvailable: () => true,
    privateStatusOutcomeWithHandle: (r: { requestId: string; opId: string; idempotencyKey: string }) => ({
      id: 1,
      promise: Promise.resolve({
        kind: "valid",
        result: {
          v: 1,
          requestId: r.requestId,
          opId: r.opId,
          op: "session/status",
          idempotencyKey: r.idempotencyKey,
          status: "succeeded",
          outcome: { type: "succeeded", time: Date.now() },
          accepted: true,
          data: { statuses },
        },
      }),
      cancel: () => true,
    }),
    privateForkWithHandle: (r: { requestId: string; opId: string; idempotencyKey: string }) => ({
      id: 11,
      promise: Promise.resolve({
        v: 1,
        requestId: r.requestId,
        opId: r.opId,
        op: "session/fork",
        idempotencyKey: r.idempotencyKey,
        status: "succeeded",
        outcome: { type: "succeeded", time: Date.now() },
        accepted: true,
        data: { session: { id: "ses_forked", parentID: "ses_src", directory: "/repo", title: "forked" } },
      }),
      cancel: () => true,
    }),
  }
}

function guardCtx(overrides: Partial<ForkContext> = {}, statusImpl?: () => string | undefined): ForkContext {
  const fork = mock(async () => ({ data: forkedSession }))
  const sdkStatus = mock(async (params: { directory: string }) => {
    expect(params.directory).toBe("/repo")
    return { data: {} }
  })
  const client = { session: { fork, status: sdkStatus } }
  const baseConnection = {
    getClient: () => client,
    isPrivateAvailable: () => false,
  }
  const merged = {
    ...baseConnection,
    ...((overrides.connection as object | undefined) ?? {}),
  }
  const { connection: _drop, ...rest } = overrides as { connection?: unknown } & Partial<ForkContext>
  void _drop
  return {
    connection: merged as never,
    post: () => undefined,
    register: () => undefined,
    forked: () => undefined,
    status: statusImpl ?? (() => undefined),
    directory: () => "/repo",
    ...rest,
  } as unknown as ForkContext
}

describe("fork guard via shared session-status helper", () => {
  it.each([["idle"], ["busy"], ["retry"], ["offline"]])("local %s keeps current determination without helper", async (type) => {
    const forked = mock(() => undefined)
    const post = mock(() => undefined)
    const c = guardCtx({ forked, post }, () => type as never)
    const conn = c.connection as unknown as {
      getClient: () => { session: { status: ReturnType<typeof mock> } }
    }
    const statusOutcome = mock(() => ({ id: 1, promise: Promise.resolve({ kind: "invalid", detail: "must not be called" }), cancel: () => true }))
    ;(conn as unknown as Record<string, unknown>).privateStatusOutcomeWithHandle = statusOutcome
    await handleForkSession(c, "ses_src")
    expect(statusOutcome).toHaveBeenCalledTimes(0)
    expect(conn.getClient().session.status).toHaveBeenCalledTimes(0)
    if (type === "idle") expect(forked).toHaveBeenCalled()
    else {
      expect(forked).not.toHaveBeenCalled()
      expect(post).toHaveBeenCalledWith({ type: "error", message: "Wait for the session to finish before forking it." })
    }
  })

  it("remote absent defaults idle and forks", async () => {
    const register = mock(() => undefined)
    const forked = mock(() => undefined)
    const c = guardCtx({ register, forked })
    c.connection = { getClient: (c.connection as unknown as { getClient: () => unknown }).getClient, ...okPrivate({}) } as never
    await handleForkSession(c, "ses_src")
    expect(register).toHaveBeenCalled()
    expect(forked).toHaveBeenCalled()
  })

  it("private success busy blocks without map/post side effects", async () => {
    const post = mock(() => undefined)
    const forked = mock(() => undefined)
    const register = mock(() => undefined)
    const c = guardCtx({ post, forked, register }, () => undefined)
    c.connection = { getClient: (c.connection as unknown as { getClient: () => unknown }).getClient, ...okPrivate({ ses_src: { type: "busy" } }) } as never
    const client = (c.connection as unknown as { getClient: () => { session: { fork: ReturnType<typeof mock> } } }).getClient()
    await handleForkSession(c, "ses_src")
    expect(forked).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith({ type: "error", message: "Wait for the session to finish before forking it." })
    expect(client.session.fork).toHaveBeenCalledTimes(0)
  })

  it("private terminal is conservative busy", async () => {
    const post = mock(() => undefined)
    const forked = mock(() => undefined)
    const c = guardCtx({ post, forked }, () => undefined)
    const terminal = {
      isPrivateAvailable: () => true,
      privateStatusOutcomeWithHandle: (r: { requestId: string; opId: string; idempotencyKey: string }) => ({
        id: 2,
        promise: Promise.resolve({
          kind: "valid",
          result: {
            v: 1,
            requestId: r.requestId,
            opId: r.opId,
            op: "session/status",
            idempotencyKey: r.idempotencyKey,
            status: "failed",
            outcome: { type: "failed", time: Date.now(), failure: { code: "internal", message: "x", retryable: false } },
            accepted: false,
            failure: { code: "internal", message: "x", retryable: false },
          },
        }),
        cancel: () => true,
      }),
    }
    c.connection = { getClient: (c.connection as unknown as { getClient: () => unknown }).getClient, ...terminal } as never
    await handleForkSession(c, "ses_src")
    expect(forked).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith({ type: "error", message: "Wait for the session to finish before forking it." })
  })

  it("fallback and timeout still fork when idle", async () => {
    for (const conn of [
      { isPrivateAvailable: () => false },
      {
        isPrivateAvailable: () => true,
        privateStatusOutcomeWithHandle: () => ({ id: 3, promise: Promise.resolve({ kind: "invalid", detail: "bad" }), cancel: () => true }),
      },
      {
        isPrivateAvailable: () => true,
        privateStatusOutcomeWithHandle: () => ({ id: 4, promise: new Promise(() => {}), cancel: () => true }),
      },
    ]) {
      const forked = mock(() => undefined)
      const c = guardCtx({ forked }, () => undefined)
      const baseClient = (c.connection as unknown as { getClient: () => { session: { fork: unknown; status: unknown } } }).getClient()
      c.connection = { getClient: () => baseClient, ...(conn as object) } as never
      // fork mutation itself stays private-unavailable in this guard test: SDK fork succeeds
      await handleForkSession(c, "ses_src")
      expect(forked).toHaveBeenCalled()
    }
  })

  it("helper failure is conservative busy", async () => {
    const post = mock(() => undefined)
    const forked = mock(() => undefined)
    const c = guardCtx({ post, forked }, () => undefined)
    c.connection = {
      getClient: () => {
        throw new Error("no client")
      },
    } as never
    await handleForkSession(c, "ses_src")
    expect(forked).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith({ type: "error", message: "Wait for the session to finish before forking it." })
  })

  it("local miss calls helper before fork with same directory", async () => {
    const order: string[] = []
    const dirs: string[] = []
    const base = guardCtx({}, () => undefined)
    const baseClient = (base.connection as unknown as { getClient: () => { session: { fork: unknown; status: unknown } } }).getClient()
    const conn = {
      getClient: () => baseClient,
      isPrivateAvailable: () => {
        order.push("private-check")
        return false
      },
      privateForkWithHandle: () => {
        order.push("fork")
        return { id: 5, promise: Promise.resolve({ v: 1, status: "failed", outcome: { type: "failed", time: 1, failure: { code: "x", message: "y", retryable: true } }, accepted: false, failure: { code: "x", message: "y", retryable: true } }), cancel: () => true }
      },
    }
    const c: ForkContext = {
      ...base,
      connection: conn as never,
      directory: (sid: string) => {
        dirs.push(sid)
        order.push("directory")
        return "/repo"
      },
      forked: mock(() => order.push("forked")),
      register: mock(() => undefined),
    }
    await handleForkSession(c, "ses_src")
    expect(order[0]).toBe("directory")
    expect(order).toContain("private-check")
    expect(order[order.length - 1]).toBe("forked")
    expect(dirs.length).toBeGreaterThanOrEqual(1)
  })
})
