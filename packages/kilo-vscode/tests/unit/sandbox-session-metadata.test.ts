import { describe, expect, it } from "bun:test"
import { SANDBOX_METADATA_KEY, sandboxDefault, sandboxSessionMetadata } from "../../src/shared/sandbox-session"

function uiOk(r: { requestId: string }, enabled: boolean) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "config/ui-defaults",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { workStyle: { hasPermission: false }, sandbox: { enabled } },
  }
}

function terminal(r: { requestId: string }) {
  const failure = { code: "internal", message: "internal error", retryable: false }
  return {
    v: 1,
    requestId: r.requestId,
    op: "config/ui-defaults",
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

function connFor(result: (q: { requestId: string }) => unknown) {
  return {
    isPrivateAvailable: () => true,
    privateConfigUiDefaultsOutcomeWithHandle: (q: { requestId: string }) => ({
      id: 1,
      promise: Promise.resolve({ kind: "valid", result: result(q) }),
      cancel: () => true,
    }),
  }
}

const throwingClient = {
  config: {
    get: async () => {
      throw new Error("must not call SDK")
    },
  },
}

describe("sandbox session metadata", () => {
  it("explicit preference short-circuits with zero private/SDK", async () => {
    for (const explicit of [true, false]) {
      const preference = { wait: async () => {}, explicit: () => explicit }
      expect(await sandboxDefault(preference as never, throwingClient as never, "/tmp", connFor((q) => uiOk(q, true)) as never)).toBe(explicit)
      const metadata = await sandboxSessionMetadata(preference as never, throwingClient as never, "/tmp", connFor((q) => uiOk(q, true)) as never, { keep: 1 })
      expect(metadata).toEqual({ keep: 1, [SANDBOX_METADATA_KEY]: { enabled: explicit, version: 0 } })
    }
  })

  it("private success flows into session metadata", async () => {
    const preference = { wait: async () => {}, explicit: () => undefined }
    expect(await sandboxDefault(preference as never, throwingClient as never, "/tmp", connFor((q) => uiOk(q, true)) as never)).toBe(true)
    expect(await sandboxDefault(preference as never, throwingClient as never, "/tmp", connFor((q) => uiOk(q, false)) as never)).toBe(false)
  })

  it("terminal and unavailable propagate instead of degrading", async () => {
    const preference = { wait: async () => {}, explicit: () => undefined }
    await expect(sandboxDefault(preference as never, throwingClient as never, "/tmp", connFor((q) => terminal(q)) as never)).rejects.toThrow()
    await expect(
      sandboxSessionMetadata(preference as never, throwingClient as never, "/tmp", connFor((q) => terminal(q)) as never),
    ).rejects.toThrow()
    const down = { isPrivateAvailable: () => false }
    await expect(sandboxDefault(preference as never, throwingClient as never, "/tmp", down as never)).rejects.toThrow()
  })

  it("SDK fallback still resolves the default for old CLIs", async () => {
    const preference = { wait: async () => {}, explicit: () => undefined }
    const client = { config: { get: async () => ({ data: { sandbox: { enabled: true } } }) } }
    expect(await sandboxDefault(preference as never, client as never, "/tmp", { isPrivateAvailable: () => false } as never)).toBe(true)
  })
})
