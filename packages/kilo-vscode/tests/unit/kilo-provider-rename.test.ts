import { describe, expect, it } from "bun:test"
import { renameSession, renameSessionWithResult } from "../../src/kilo-provider/rename-session"
import { SESSION_TITLE_LIMIT } from "../../src/shared/session-title"

type Params = { sessionID: string; directory?: string; title?: string; context?: unknown; opId?: unknown; idempotencyKey?: unknown; requestId?: unknown }

function client() {
  const calls: Params[] = []
  return {
    calls,
    value: {
      session: {
        update: async (params: Params) => {
          calls.push(params)
          return {
            data: {
              id: params.sessionID,
              title: params.title,
              time: { created: 1, updated: 2 },
            },
          }
        },
      },
    },
  }
}

describe("renameSession", () => {
  it("normalizes and persists a valid title through the backend client (legacy, no durable)", async () => {
    const api = client()

    const updated = await renameSession({
      client: api.value as never,
      sessionID: "ses_1",
      title: "  Rename active session  ",
      directory: "/repo",
    })

    expect(api.calls).toHaveLength(1)
    expect(api.calls[0]).toMatchObject({ sessionID: "ses_1", directory: "/repo", title: "Rename active session" })
    const call = api.calls[0] as Record<string, unknown>
    // legacy default must not opt into durable — no opId/idempotencyKey/context
    expect(call.opId).toBeUndefined()
    expect(call.idempotencyKey).toBeUndefined()
    expect(call.requestId).toBeUndefined()
    expect(call.context).toBeUndefined()
    expect(updated.title).toBe("Rename active session")
  })

  it("uses caller-supplied durable identity tuple when provided", async () => {
    const api = client()
    const ctx = { directory: "/repo", sessionId: "ses_1", parentSessionId: null as const }
    await renameSession({
      client: api.value as never,
      sessionID: "ses_1",
      title: "hello",
      directory: "/repo",
      opId: "sessionUpdate:ses_1",
      idempotencyKey: "sessionUpdate:ses_1:fixed-key",
      requestId: "req-fixed",
      context: ctx,
    } as never)
    expect(api.calls[0]).toMatchObject({ sessionID: "ses_1", title: "hello" })
    const call = api.calls[0] as Record<string, unknown>
    expect(call.opId).toBe("sessionUpdate:ses_1")
    expect(call.idempotencyKey).toBe("sessionUpdate:ses_1:fixed-key")
    expect(call.requestId).toBe("req-fixed")
    expect(call.context).toBe(ctx)
    expect(call.context).toMatchObject({ directory: "/repo", sessionId: "ses_1", parentSessionId: null })
  })

  it("forwards explicit durable context unchanged to SDK (exact values)", async () => {
    const api = client()
    const ctx = { directory: "/repo", sessionId: "ses_1", parentSessionId: null as const, configVersion: 2, sessionRevision: 5 }
    await renameSession({
      client: api.value as never,
      sessionID: "ses_1",
      title: "hello",
      directory: "/repo",
      opId: "sessionUpdate:ses_1:tok",
      idempotencyKey: "sessionUpdate:ses_1:tok",
      requestId: "req-1",
      context: ctx,
    } as never)
    const call = api.calls[0] as Record<string, unknown>
    expect(call.context).toBe(ctx)
    expect(call.context).toEqual(ctx)
  })

  it("rejects durable without explicit context and does not synthesize", async () => {
    const api = client()
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        opId: "sessionUpdate:ses_1",
        idempotencyKey: "sessionUpdate:ses_1:fixed-key",
        requestId: "req-fixed",
      } as never),
    ).rejects.toThrow("Invalid durable context")
    expect(api.calls).toEqual([])
  })

  it("rejects partial durable context (missing parentSessionId null, missing directory, or missing sessionId)", async () => {
    const api = client()
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        opId: "sessionUpdate:ses_1:tok",
        idempotencyKey: "sessionUpdate:ses_1:tok",
        requestId: "req-1",
        context: { directory: "/repo", sessionId: "ses_1" } as never,
      } as never),
    ).rejects.toThrow("Invalid durable context")
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        opId: "sessionUpdate:ses_1:tok",
        idempotencyKey: "sessionUpdate:ses_1:tok",
        requestId: "req-1",
        context: { directory: "", sessionId: "ses_1", parentSessionId: null } as never,
      } as never),
    ).rejects.toThrow("Invalid durable context")
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        opId: "sessionUpdate:ses_1:tok",
        idempotencyKey: "sessionUpdate:ses_1:tok",
        requestId: "req-1",
        context: { directory: "/repo", sessionId: "ses_1", parentSessionId: "ses_other" } as never,
      } as never),
    ).rejects.toThrow("Invalid durable context")
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        opId: "sessionUpdate:ses_1:tok",
        idempotencyKey: "sessionUpdate:ses_1:tok",
        requestId: "req-1",
        context: { directory: "/repo", sessionId: "", parentSessionId: null } as never,
      } as never),
    ).rejects.toThrow("Invalid durable context")
    expect(api.calls).toEqual([])
  })

  it("rejects context-only durable opt-in without identity", async () => {
    const api = client()
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        context: { directory: "/repo", sessionId: "ses_1", parentSessionId: null } as never,
      } as never),
    ).rejects.toThrow("Invalid durable identity")
    expect(api.calls).toEqual([])
  })

  it("renameSessionWithResult requires explicit context and forwards it unchanged", async () => {
    const api = client()
    const ctx = { directory: "/repo", sessionId: "ses_1", parentSessionId: null as const }
    const res = await renameSessionWithResult({
      client: api.value as never,
      sessionID: "ses_1",
      title: "hello",
      directory: "/repo",
      opId: "sessionUpdate:ses_1:tok",
      idempotencyKey: "sessionUpdate:ses_1:tok",
      requestId: "req-1",
      context: ctx,
    })
    expect(api.calls[0]).toMatchObject({ sessionID: "ses_1", title: "hello" })
    const call = api.calls[0] as Record<string, unknown>
    expect(call.context).toBe(ctx)
    expect(res).toBeDefined()
  })

  it("renameSessionWithResult rejects missing or partial context", async () => {
    const api = client()
    await expect(
      renameSessionWithResult({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        opId: "sessionUpdate:ses_1:tok",
        idempotencyKey: "sessionUpdate:ses_1:tok",
        requestId: "req-1",
        context: undefined as never,
      }),
    ).rejects.toThrow("Invalid durable context")
    await expect(
      renameSessionWithResult({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        opId: "sessionUpdate:ses_1:tok",
        idempotencyKey: "sessionUpdate:ses_1:tok",
        requestId: "req-1",
        context: { directory: "/repo", sessionId: "ses_1" } as never,
      }),
    ).rejects.toThrow("Invalid durable context")
    expect(api.calls).toEqual([])
  })

  it("rejects unsafe titles before they reach the backend", async () => {
    const api = client()
    const input = [" ", "a".repeat(SESSION_TITLE_LIMIT + 1), "Title\nSecond line", "Title\u202espoof"]

    for (const title of input) {
      await expect(
        renameSession({ client: api.value as never, sessionID: "ses_1", title, directory: "/repo" }),
      ).rejects.toThrow("Invalid session title")
    }

    expect(api.calls).toEqual([])
  })

  it("rejects partial durable identity instead of completing with random keys", async () => {
    const api = client()
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        opId: "sessionUpdate:ses_1:tok",
      } as never),
    ).rejects.toThrow("Invalid durable identity")
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        idempotencyKey: "sessionUpdate:ses_1:tok",
      } as never),
    ).rejects.toThrow("Invalid durable identity")
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        requestId: "req-1",
      } as never),
    ).rejects.toThrow("Invalid durable identity")
    expect(api.calls).toEqual([])
  })

  it("rejects explicit empty string durable identity as invalid opt-in, not legacy", async () => {
    const api = client()
    const ctx = { directory: "/repo", sessionId: "ses_1", parentSessionId: null as const }
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        opId: "",
        idempotencyKey: "",
        requestId: "",
        context: ctx,
      } as never),
    ).rejects.toThrow("Invalid durable identity")
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        opId: "",
      } as never),
    ).rejects.toThrow("Invalid durable identity")
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        idempotencyKey: "",
      } as never),
    ).rejects.toThrow("Invalid durable identity")
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        requestId: "",
      } as never),
    ).rejects.toThrow("Invalid durable identity")
    expect(api.calls).toEqual([])
  })

  it("rejects explicit falsy/invalid context as durable opt-in, not legacy downgrade", async () => {
    const api = client()
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        opId: "sessionUpdate:ses_1:tok",
        idempotencyKey: "sessionUpdate:ses_1:tok",
        requestId: "req-1",
        context: null as never,
      }),
    ).rejects.toThrow("Invalid durable context")
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        opId: "sessionUpdate:ses_1:tok",
        idempotencyKey: "sessionUpdate:ses_1:tok",
        requestId: "req-1",
        context: "" as never,
      }),
    ).rejects.toThrow("Invalid durable context")
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        opId: "sessionUpdate:ses_1:tok",
        idempotencyKey: "sessionUpdate:ses_1:tok",
        requestId: "req-1",
        context: {} as never,
      }),
    ).rejects.toThrow("Invalid durable context")
    await expect(
      renameSession({
        client: api.value as never,
        sessionID: "ses_1",
        title: "hello",
        directory: "/repo",
        context: null as never,
      }),
    ).rejects.toThrow("Invalid durable identity")
    expect(api.calls).toEqual([])
  })
})
