import { describe, expect, test } from "bun:test"
import {
  attemptSandboxSupportPrivate,
  buildSandboxSupportReq,
  fetchSandboxSupportPrivateFirst,
  parseSandboxSupportResult,
} from "./sandbox-support-privatefirst"
import { validateSandboxSupportContractRequest } from "../services/cli-backend/serve-private-sandbox-support-contract"

const DIR = "/tmp/sandbox-support"

function req() {
  return buildSandboxSupportReq(DIR)
}

function okFor(r: ReturnType<typeof req>, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "sandbox/support",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { available: true, ...overrides },
  }
}

function failedFor(r: ReturnType<typeof req>, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return {
    v: 1,
    requestId: r.requestId,
    op: "sandbox/support",
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
    op: "sandbox/support",
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

function connFor(result: (q: ReturnType<typeof req>) => unknown, id = 1) {
  return {
    isPrivateAvailable: () => true,
    privateSandboxSupportOutcomeWithHandle: (q: ReturnType<typeof req>) => ({
      id,
      promise: Promise.resolve({ kind: "valid", result: result(q) }),
      cancel: () => true,
    }),
  }
}

describe("sandbox-support private-first", () => {
  test("request is requestId-only with strict directory binding", () => {
    const r = req()
    expect(r.v).toBe(1)
    expect(r.op).toBe("sandbox/support")
    expect(typeof r.requestId).toBe("string")
    expect((r as Record<string, unknown>).opId).toBeUndefined()
    expect((r as Record<string, unknown>).idempotencyKey).toBeUndefined()
    expect(r.context.directory).toBe(DIR)
    expect(() => validateSandboxSupportContractRequest(r)).not.toThrow()
    expect(() => validateSandboxSupportContractRequest({ ...r, opId: "x" })).toThrow()
    expect(() => validateSandboxSupportContractRequest({ ...r, payload: { f: 1 } })).toThrow()
  })

  test("succeeded accepted parses ok, available:false stays ok", () => {
    const r = req()
    const parsed = parseSandboxSupportResult(okFor(r), r)
    expect(parsed.kind).toBe("ok")
    const unavailable = parseSandboxSupportResult(okFor(r, { available: false, reason: "no backend" }), r)
    expect(unavailable.kind).toBe("ok")
    if (unavailable.kind === "ok") expect(unavailable.support.available).toBe(false)
  })

  test("validated terminals close with zero SDK", async () => {
    for (const [code, message] of [
      ["validation.failed", "invalid sandbox support request"],
      ["scope_mismatch", "directory mismatch"],
    ] as const) {
      let sdk = 0
      const out = await fetchSandboxSupportPrivateFirst({
        connection: connFor((q) => failedFor(q, code, message, false)) as never,
        client: { sandbox: { support: async () => { sdk += 1; return { data: {} } } } } as never,
        directory: DIR,
      })
      expect(out.kind).toBe("terminal")
      expect(sdk).toBe(0)
    }
  })

  test("config rebuild and internal are fallback-eligible, generic rejection stays fallback", async () => {
    const r = req()
    const fence = await attemptSandboxSupportPrivate(
      connFor((q) => failedFor(q, "InstanceUnavailableDuringConfigRebuild", "Instance is unavailable during config rebuild; no active runtime for this request", true)) as never,
      r,
    )
    expect(fence.kind).toBe("fallback")
    const internal = await attemptSandboxSupportPrivate(
      connFor((q) => failedFor(q, "internal", "internal error", true)) as never,
      req(),
    )
    expect(internal.kind).toBe("fallback")
    const generic = await attemptSandboxSupportPrivate(
      connFor(() => ({
        v: 1,
        requestId: r.requestId,
        op: "sandbox/support",
        status: "failed",
        outcome: { type: "failed", time: 1, failure: { code: "-32603", message: "boom", retryable: false } },
        accepted: false,
        failure: { code: "-32603", message: "boom", retryable: false },
      })) as never,
      r,
    )
    expect(generic.kind).toBe("fallback")
  })

  test("unavailable/capability/invalid/ambiguous/closed/timeout take exactly one SDK fallback", async () => {
    const r1 = req()
    expect((await attemptSandboxSupportPrivate({ isPrivateAvailable: () => false } as never, r1)).kind).toBe("fallback")

    const r2 = req()
    expect((await attemptSandboxSupportPrivate(connFor((q) => ambiguousFor(q)) as never, r2)).kind).toBe("fallback")

    const r3 = req()
    const invalid = {
      isPrivateAvailable: () => true,
      privateSandboxSupportOutcomeWithHandle: () => ({
        id: 3,
        promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
        cancel: () => true,
      }),
    }
    expect((await attemptSandboxSupportPrivate(invalid as never, r3)).kind).toBe("fallback")

    const r4 = req()
    const transport = {
      isPrivateAvailable: () => true,
      privateSandboxSupportOutcomeWithHandle: () => ({
        id: 4,
        promise: Promise.reject(new Error("Private peer unavailable")),
        cancel: () => true,
      }),
    }
    expect((await attemptSandboxSupportPrivate(transport as never, r4)).kind).toBe("fallback")

    const r5 = req()
    const hanging = {
      isPrivateAvailable: () => true,
      privateSandboxSupportOutcomeWithHandle: () => ({
        id: 5,
        promise: new Promise(() => {}),
        cancel: () => true,
      }),
    }
    expect((await attemptSandboxSupportPrivate(hanging as never, r5, 10)).kind).toBe("fallback")
  })

  test("timeout exact-cancels the pending by id", async () => {
    const r = req()
    const cancelled: unknown[] = []
    const hanging = {
      isPrivateAvailable: () => true,
      privateSandboxSupportOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: (msg?: string) => {
          cancelled.push(msg)
          return true
        },
      }),
    }
    const out = await attemptSandboxSupportPrivate(hanging as never, r, 10)
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
    expect(cancelled.length).toBe(1)
    expect(String(cancelled[0]).includes(r.requestId)).toBeTrue()
  })

  test("private success returns zero SDK, fallback uses exact same directory once", async () => {
    let sdk = 0
    const client = { sandbox: { support: async () => { sdk += 1; return { data: {} } } } } as never
    const conn = connFor((q) => okFor(q))
    const out = await fetchSandboxSupportPrivateFirst({ connection: conn as never, client, directory: DIR })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") expect(out.via).toBe("private")
    expect(sdk).toBe(0)

    let calls = 0
    const fallbackClient = {
      sandbox: {
        support: async (args: { directory: string }) => {
          calls += 1
          expect(args.directory).toBe(DIR)
          return { data: { available: false, reason: "no backend" } }
        },
      },
    } as never
    const out2 = await fetchSandboxSupportPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: fallbackClient,
      directory: DIR,
    })
    expect(out2.kind).toBe("ok")
    if (out2.kind === "ok") expect(out2.via).toBe("sdk")
    expect(calls).toBe(1)
  })

  test("helper never retries SDK or issues a second private call", async () => {
    let sdk = 0
    let priv = 0
    const client = {
      sandbox: {
        support: async () => {
          sdk += 1
          throw new Error("load failed: transient boom")
        },
      },
    } as never
    const conn = {
      isPrivateAvailable: () => true,
      privateSandboxSupportOutcomeWithHandle: (q: ReturnType<typeof req>) => {
        priv += 1
        return { id: 1, promise: Promise.resolve({ kind: "invalid", detail: "bad" }), cancel: () => true }
      },
    } as never
    const out = await fetchSandboxSupportPrivateFirst({ connection: conn, client, directory: DIR })
    expect(out.kind).toBe("unavailable")
    expect(sdk).toBe(1)
    expect(priv).toBe(1)
  })

  test("closed result validation: malformed private and SDK wire fall back", async () => {
    const r = req()
    const malformed = parseSandboxSupportResult({ ...okFor(r), data: { available: "yes" } }, r)
    expect(malformed.kind).toBe("fallback")
    const client = { sandbox: { support: async () => ({ data: { available: "yes" } }) } } as never
    const conn = { isPrivateAvailable: () => false } as never
    const out = await fetchSandboxSupportPrivateFirst({ connection: conn, client, directory: DIR })
    expect(out.kind).toBe("unavailable")
  })
})
