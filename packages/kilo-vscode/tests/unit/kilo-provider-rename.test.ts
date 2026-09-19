import { describe, expect, it } from "bun:test"
import { renameSessionWithResult } from "../../src/kilo-provider/rename-session"

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

describe("renameSessionWithResult", () => {
  it("requires explicit context and forwards it unchanged", async () => {
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

  it("rejects missing or partial context", async () => {
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
})
