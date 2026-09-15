import { describe, expect, test } from "bun:test"
import {
  attemptSandboxStatusPrivate,
  buildSandboxStatusReq,
  fetchSandboxStatusPrivateFirst,
  parseSandboxStatusResult,
} from "./sandbox-status-privatefirst"
import { validateSandboxStatusContractRequest } from "../services/cli-backend/serve-private-sandbox-status-contract"

const SID = "ses_status123"
const DIR = "/tmp/sandbox-status"

function req() {
  return buildSandboxStatusReq(SID, DIR)
}

function okFor(r: ReturnType<typeof req>, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "sandbox/status",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status: { directory: DIR, enabled: true, available: true, version: 2, ...overrides } },
  }
}

function failedFor(r: ReturnType<typeof req>, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return {
    v: 1,
    requestId: r.requestId,
    op: "sandbox/status",
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
    op: "sandbox/status",
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

function connFor(result: (q: ReturnType<typeof req>) => unknown, id = 1) {
  return {
    isPrivateAvailable: () => true,
    privateSandboxStatusOutcomeWithHandle: (q: ReturnType<typeof req>) => ({
      id,
      promise: Promise.resolve({ kind: "valid", result: result(q) }),
      cancel: () => true,
    }),
  }
}

describe("sandbox-status private-first", () => {
  test("request is requestId-only with strict session/directory binding", () => {
    const r = req()
    expect(r.v).toBe(1)
    expect(r.op).toBe("sandbox/status")
    expect(typeof r.requestId).toBe("string")
    expect((r as Record<string, unknown>).opId).toBeUndefined()
    expect((r as Record<string, unknown>).idempotencyKey).toBeUndefined()
    expect(r.context.sessionId).toBe(SID)
    expect(r.context.directory).toBe(DIR)
    expect(() => validateSandboxStatusContractRequest(r)).not.toThrow()
    expect(() => validateSandboxStatusContractRequest({ ...r, opId: "x" })).toThrow()
    expect(() => validateSandboxStatusContractRequest({ ...r, payload: { f: 1 } })).toThrow()
  })

  test("succeeded accepted parses ok, available:false stays ok", () => {
    const r = req()
    const parsed = parseSandboxStatusResult(okFor(r), r)
    expect(parsed.kind).toBe("ok")
    const unavailable = parseSandboxStatusResult(okFor(r, { available: false, enabled: false }), r)
    expect(unavailable.kind).toBe("ok")
    if (unavailable.kind === "ok") expect(unavailable.status.available).toBe(false)
  })

  test("validated domain terminals close with zero SDK", async () => {
    for (const [code, message] of [
      ["validation.failed", "invalid sandbox status request"],
      ["scope_mismatch", "directory mismatch"],
      ["session.not_found", "session not found"],
    ] as const) {
      let sdk = 0
      const out = await fetchSandboxStatusPrivateFirst({
        connection: connFor((q) => failedFor(q, code, message, false)) as never,
        client: { sandbox: { status: async () => { sdk += 1; return { data: {} } } } } as never,
        sessionId: SID,
        directory: DIR,
      })
      expect(out.kind).toBe("terminal")
      expect(sdk).toBe(0)
    }
  })

  test("config rebuild and internal are fallback-eligible, generic rejection stays fallback", async () => {
    const r = req()
    const fence = await attemptSandboxStatusPrivate(
      connFor((q) => failedFor(q, "InstanceUnavailableDuringConfigRebuild", "Instance is unavailable during config rebuild; no active runtime for this request", true)) as never,
      r,
    )
    expect(fence.kind).toBe("fallback")
    const internal = await attemptSandboxStatusPrivate(
      connFor((q) => failedFor(q, "internal", "internal error", true)) as never,
      req(),
    )
    expect(internal.kind).toBe("fallback")
    // Unknown failure code fails closed validation -> fallback, never terminal.
    const generic = await attemptSandboxStatusPrivate(
      connFor(() => ({
        v: 1,
        requestId: r.requestId,
        op: "sandbox/status",
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
    expect((await attemptSandboxStatusPrivate({ isPrivateAvailable: () => false } as never, r1)).kind).toBe("fallback")

    const r2 = req()
    expect((await attemptSandboxStatusPrivate(connFor((q) => ambiguousFor(q)) as never, r2)).kind).toBe("fallback")

    const r3 = req()
    const invalid = {
      isPrivateAvailable: () => true,
      privateSandboxStatusOutcomeWithHandle: () => ({
        id: 3,
        promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
        cancel: () => true,
      }),
    }
    expect((await attemptSandboxStatusPrivate(invalid as never, r3)).kind).toBe("fallback")

    const r4 = req()
    const transport = {
      isPrivateAvailable: () => true,
      privateSandboxStatusOutcomeWithHandle: () => ({
        id: 4,
        promise: Promise.reject(new Error("Private peer unavailable")),
        cancel: () => true,
      }),
    }
    expect((await attemptSandboxStatusPrivate(transport as never, r4)).kind).toBe("fallback")

    const r5 = req()
    const hanging = {
      isPrivateAvailable: () => true,
      privateSandboxStatusOutcomeWithHandle: () => ({
        id: 5,
        promise: new Promise(() => {}),
        cancel: () => true,
      }),
    }
    expect((await attemptSandboxStatusPrivate(hanging as never, r5, 10)).kind).toBe("fallback")
  })

  test("timeout exact-cancels the pending by id", async () => {
    const r = req()
    const cancelled: unknown[] = []
    const hanging = {
      isPrivateAvailable: () => true,
      privateSandboxStatusOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: (msg?: string) => {
          cancelled.push(msg)
          return true
        },
      }),
    }
    const out = await attemptSandboxStatusPrivate(hanging as never, r, 10)
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
    expect(cancelled.length).toBe(1)
    expect(String(cancelled[0]).includes(r.requestId)).toBeTrue()
  })

  test("private success returns zero SDK, fallback uses exact same session/directory once", async () => {
    let sdk = 0
    const client = { sandbox: { status: async () => { sdk += 1; return { data: {} } } } } as never
    const conn = connFor((q) => okFor(q))
    const out = await fetchSandboxStatusPrivateFirst({ connection: conn as never, client, sessionId: SID, directory: DIR })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") expect(out.via).toBe("private")
    expect(sdk).toBe(0)

    let calls = 0
    const fallbackClient = {
      sandbox: {
        status: async (args: { sessionID: string; directory: string }) => {
          calls += 1
          expect(args.sessionID).toBe(SID)
          expect(args.directory).toBe(DIR)
          return { data: { directory: DIR, enabled: false, available: false, version: 0 } }
        },
      },
    } as never
    const out2 = await fetchSandboxStatusPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: fallbackClient,
      sessionId: SID,
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
        status: async () => {
          sdk += 1
          throw new Error("load failed: transient boom")
        },
      },
    } as never
    const conn = {
      isPrivateAvailable: () => true,
      privateSandboxStatusOutcomeWithHandle: (q: ReturnType<typeof req>) => {
        priv += 1
        return { id: 1, promise: Promise.resolve({ kind: "invalid", detail: "bad" }), cancel: () => true }
      },
    } as never
    const out = await fetchSandboxStatusPrivateFirst({ connection: conn, client, sessionId: SID, directory: DIR })
    expect(out.kind).toBe("unavailable")
    expect(sdk).toBe(1)
    expect(priv).toBe(1)
  })

  test("closed result validation: malformed private and SDK wire fall back", async () => {
    const r = req()
    const malformed = parseSandboxStatusResult({ ...okFor(r), data: { status: { ...okFor(r).data.status, version: "x" } } }, r)
    expect(malformed.kind).toBe("fallback")
    const client = { sandbox: { status: async () => ({ data: { directory: DIR, enabled: true } }) } } as never
    const conn = { isPrivateAvailable: () => false } as never
    const out = await fetchSandboxStatusPrivateFirst({ connection: conn, client, sessionId: SID, directory: DIR })
    expect(out.kind).toBe("unavailable")
  })
})
