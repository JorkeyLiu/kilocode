import { describe, expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { ensureSandbox } from "../../src/agent-manager/sandbox-bootstrap"

type State = {
  directory: string
  enabled: boolean
  available: boolean
  reason?: string
  version: number
}

function setup(states: State[]) {
  const calls: string[] = []
  const fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      calls.push(`${request.method} ${new URL(request.url).pathname}`)
      const state = states.shift()
      if (!state) return Response.json({ message: "Unexpected request" }, { status: 500 })
      return Response.json(state)
    },
    { preconnect: globalThis.fetch.preconnect },
  ) satisfies typeof globalThis.fetch

  return {
    calls,
    client: createKiloClient({ baseUrl: "http://localhost", fetch }),
  }
}

function state(enabled: boolean, available = true, directory = "/repo"): State {
  return { directory, enabled, available, version: 1 }
}

describe("ensureSandbox", () => {
  test("does not toggle when the effective state already matches", async () => {
    const ctx = setup([state(true)])

    const result = await ensureSandbox(ctx.client, "session-1", "/repo", true)

    expect(result.enabled).toBe(true)
    expect(ctx.calls).toEqual(["GET /session/session-1/sandbox"])
  })

  test("toggles and verifies the selected state", async () => {
    const ctx = setup([state(false), state(true)])

    const result = await ensureSandbox(ctx.client, "session-1", "/repo", true)

    expect(result.enabled).toBe(true)
    expect(ctx.calls).toEqual(["GET /session/session-1/sandbox", "POST /session/session-1/sandbox/toggle"])
  })

  test("rejects unavailable sandboxing when sandbox was requested", async () => {
    const unavailable = { ...state(false, false), reason: "Sandbox backend unavailable" }
    const ctx = setup([unavailable])

    expect(ensureSandbox(ctx.client, "session-1", "/repo", true)).rejects.toThrow("Sandbox backend unavailable")
    expect(ctx.calls).toEqual(["GET /session/session-1/sandbox"])
  })

  test("allows an effectively disabled sandbox when the backend is unavailable", async () => {
    const ctx = setup([state(false, false)])

    const result = await ensureSandbox(ctx.client, "session-1", "/repo", false)

    expect(result.enabled).toBe(false)
    expect(ctx.calls).toEqual(["GET /session/session-1/sandbox"])
  })

  test("rejects a toggle that does not reach the selected state", async () => {
    const ctx = setup([state(false), state(false)])

    expect(ensureSandbox(ctx.client, "session-1", "/repo", true)).rejects.toThrow(
      "Sandbox remained disabled after reconciliation",
    )
  })

  test("rejects status returned for a different directory without toggling", async () => {
    const ctx = setup([state(false, true, "/other")])

    expect(ensureSandbox(ctx.client, "session-1", "/repo", true)).rejects.toThrow(
      "Sandbox status resolved a different directory",
    )
    expect(ctx.calls).toEqual(["GET /session/session-1/sandbox"])
  })
})
