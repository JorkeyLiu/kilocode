import { describe, expect, test } from "bun:test"
import {
  attemptProviderModelsDiscoverPrivate,
  buildProviderModelsDiscoverReq,
  discoverModelsPrivateFirst,
  parseProviderModelsDiscoverResult,
} from "./models-discover-privatefirst"

function models() {
  return [{ id: "m1", name: "M1" }]
}

function req() {
  return buildProviderModelsDiscoverReq("/tmp/discover", "test", "https://example.com/v1")
}

function okFor(r: ReturnType<typeof req>, d: unknown = { models: models() }) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "provider/models-discover",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: d,
  }
}

function failedFor(r: ReturnType<typeof req>, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return {
    v: 1,
    requestId: r.requestId,
    op: "provider/models-discover",
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

function ambiguousFor(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "provider/models-discover",
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

function connFor(result: (q: ReturnType<typeof req>) => unknown, id = 1) {
  return {
    isPrivateAvailable: () => true,
    privateProviderModelsDiscoverOutcomeWithHandle: (q: ReturnType<typeof req>) => ({
      id,
      promise: Promise.resolve({ kind: "valid", result: result(q) }),
      cancel: () => true,
    }),
  }
}

describe("provider models-discover private-first", () => {
  test("success returns private with zero SDK", async () => {
    const out = await discoverModelsPrivateFirst({
      connection: connFor((q) => okFor(q)) as never,
      client: {
        provider: {
          models: {
            discover: async () => {
              throw new Error("must not call SDK")
            },
          },
        },
      } as never,
      directory: "/tmp/discover",
      providerID: "test",
      baseURL: "https://example.com/v1",
    })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") {
      expect(out.via).toBe("private")
      expect(out.models).toEqual(models())
    }
  })

  test("terminal closes with zero SDK and maps unauthorized to auth UX", async () => {
    for (const [code, message, auth] of [
      ["validation.failed", "invalid provider models-discover request", false],
      ["scope_mismatch", "directory mismatch", false],
      ["unauthorized", "stored credential failed authentication", true],
      ["invalid_response", "provider returned an invalid models response", false],
      ["upstream_error", "provider models request failed", false],
      ["internal", "internal error", false],
    ] as Array<[string, string, boolean]>) {
      let sdk = 0
      const out = await discoverModelsPrivateFirst({
        connection: connFor((q) => failedFor(q, code, message, false)) as never,
        client: {
          provider: {
            models: {
              discover: async () => {
                sdk += 1
                return { data: { models: models() } }
              },
            },
          },
        } as never,
        directory: "/tmp/discover",
        providerID: "test",
        baseURL: "https://example.com/v1",
      })
      expect(out.kind).toBe("terminal")
      if (out.kind === "terminal") {
        expect(out.code).toBe(code)
        expect(out.message).toBe(message)
        expect(out.auth).toBe(auth)
      }
      expect(sdk).toBe(0)
    }
  })

  test("retryable/invalid/ambiguous/transport/timeout take exactly one SDK fallback", async () => {
    for (const maker of [
      (q: ReturnType<typeof req>) =>
        failedFor(
          q,
          "InstanceUnavailableDuringConfigRebuild",
          "Instance is unavailable during config rebuild; no active runtime for this request",
          true,
        ),
      (q: ReturnType<typeof req>) => ambiguousFor(q),
      (_q: ReturnType<typeof req>) => ({ v: 1, bad: true }),
    ]) {
      let sdk = 0
      let seen: unknown = null
      const out = await discoverModelsPrivateFirst({
        connection: connFor(maker as never) as never,
        client: {
          provider: {
            models: {
              discover: async (args: unknown) => {
                sdk += 1
                seen = args
                return { data: { models: models() } }
              },
            },
          },
        } as never,
        directory: "/tmp/discover",
        providerID: "test",
        baseURL: "https://example.com/v1",
      })
      expect(out.kind).toBe("ok")
      if (out.kind === "ok") expect(out.via).toBe("sdk")
      expect(sdk).toBe(1)
      expect(seen).toEqual({ providerID: "test", baseURL: "https://example.com/v1", directory: "/tmp/discover" })
    }
  })

  test("SDK failure or malformed SDK payload returns unavailable", async () => {
    const down = await discoverModelsPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: {
        provider: {
          models: {
            discover: async () => {
              throw new Error("sdk down")
            },
          },
        },
      } as never,
      directory: "/tmp/discover",
      providerID: "test",
      baseURL: "https://example.com/v1",
    })
    expect(down.kind).toBe("unavailable")

    const malformed = await discoverModelsPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: {
        provider: {
          models: { discover: async () => ({ data: { models: [{ id: "m1", name: "M1", key: "sk-leak" }] } }) },
        },
      } as never,
      directory: "/tmp/discover",
      providerID: "test",
      baseURL: "https://example.com/v1",
    })
    expect(malformed.kind).toBe("unavailable")
  })

  test("timeout exact-cancels and falls back once", async () => {
    const r = buildProviderModelsDiscoverReq("/tmp/discover", "test", "https://example.com/v1")
    let cancelled = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateProviderModelsDiscoverOutcomeWithHandle: () => ({
        id: 9,
        promise: new Promise(() => {}),
        cancel: () => {
          cancelled += 1
          return true
        },
      }),
    }
    const attempt = await attemptProviderModelsDiscoverPrivate(conn as never, r, 10)
    expect(attempt.kind).toBe("fallback")
    expect(attempt.kind === "fallback" ? attempt.reason : "").toBe("timeout")
    expect(cancelled).toBe(1)
  })

  test("request carries the exact stored-credential payload", () => {
    const r = buildProviderModelsDiscoverReq("/tmp/discover", "test", "https://example.com/v1")
    expect(r.op).toBe("provider/models-discover")
    expect(r.payload).toEqual({ providerID: "test", baseURL: "https://example.com/v1" })
    expect("opId" in r).toBeFalse()
  })

  test("parse maps settled-first correctly", () => {
    const r = req()
    expect(parseProviderModelsDiscoverResult(okFor(r), r).kind).toBe("ok")
    const terminal = parseProviderModelsDiscoverResult(
      failedFor(r, "unauthorized", "stored credential failed authentication", false),
      r,
    )
    expect(terminal.kind).toBe("terminal")
    expect(
      parseProviderModelsDiscoverResult(
        failedFor(
          r,
          "InstanceUnavailableDuringConfigRebuild",
          "Instance is unavailable during config rebuild; no active runtime for this request",
          true,
        ),
        r,
      ).kind,
    ).toBe("fallback")
    expect(parseProviderModelsDiscoverResult(ambiguousFor(r), r).kind).toBe("fallback")
  })
})
