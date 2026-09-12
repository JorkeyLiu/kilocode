import { describe, expect, test } from "bun:test"
import {
  attemptSessionModelUsagePrivate,
  buildSessionModelUsageIdentity,
  parseSessionModelUsageResult,
} from "./session-model-usage"
import { canonicalSessionModelUsageOpId } from "../services/cli-backend/serve-private-session-model-usage-contract"

const SID = "ses_abc123"
const DIR = "/tmp"

function usage() {
  return {
    sessionIDs: [SID],
    totals: { steps: 1, cost: 0.5, tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    models: [
      {
        providerID: "p",
        modelID: "m",
        steps: 1,
        cost: 0.5,
        tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ],
  }
}

function req() {
  const { opId, idempotencyKey, requestId } = buildSessionModelUsageIdentity(SID)
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "session/model-usage" as const,
    idempotencyKey,
    context: { directory: DIR, sessionId: SID },
    payload: {},
  }
}

function okFor(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "session/model-usage",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { usage: usage() },
  }
}

function terminalFor(r: ReturnType<typeof req>, code = "session.not_found") {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "session/model-usage",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable: false } },
    accepted: false,
    failure: { code, message: "m", retryable: false },
  }
}

function retryableFor(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "session/model-usage",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: {
      type: "failed",
      time: 1,
      failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
    },
    accepted: false,
    failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
  }
}

function ambiguousFor(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "session/model-usage",
    idempotencyKey: r.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

describe("session model usage private-first", () => {
  test("identity binds canonical session-model-usage tuple", () => {
    const { opId, idempotencyKey, requestId } = buildSessionModelUsageIdentity(SID)
    expect(opId).toBe(idempotencyKey)
    expect(opId.startsWith(`session-model-usage:${SID}:`)).toBeTrue()
    const token = opId.split(":")[2]!
    expect(canonicalSessionModelUsageOpId(SID, token)).toBe(opId)
    expect(typeof requestId).toBe("string")
  })

  test("succeeded accepted returns ok with identical shape", () => {
    const r = req()
    const parsed = parseSessionModelUsageResult(okFor(r), r)
    expect(parsed.kind).toBe("ok")
    if (parsed.kind === "ok") expect(parsed.usage).toEqual(usage())
  })

  test("terminal failed closes without SDK", async () => {
    for (const code of ["session.not_found", "scope_mismatch", "validation.failed"]) {
      const r = req()
      const connection = {
        isPrivateAvailable: () => true,
        privateSessionModelUsageOutcomeWithHandle: (q: typeof r) => ({
          id: 1,
          promise: Promise.resolve({ kind: "valid", result: terminalFor(q, code) }),
          cancel: () => true,
        }),
      }
      const out = await attemptSessionModelUsagePrivate(connection as never, r)
      expect(out).toEqual({ kind: "terminal" })
    }
  })

  test("unavailable/ambiguous/invalid/transport/timeout are fallback-eligible", async () => {
    const cases: Array<{ conn: unknown; r: ReturnType<typeof req> }> = []
    const r1 = req()
    cases.push({
      r: r1,
      conn: {
        isPrivateAvailable: () => false,
        privateSessionModelUsageOutcomeWithHandle: () => {
          throw new Error("must not be called")
        },
      },
    })
    const r2 = req()
    cases.push({
      r: r2,
      conn: {
        isPrivateAvailable: () => true,
        privateSessionModelUsageOutcomeWithHandle: (q: typeof r2) => ({
          id: 2,
          promise: Promise.resolve({ kind: "valid", result: ambiguousFor(q) }),
          cancel: () => true,
        }),
      },
    })
    const r3 = req()
    cases.push({
      r: r3,
      conn: {
        isPrivateAvailable: () => true,
        privateSessionModelUsageOutcomeWithHandle: () => ({
          id: 3,
          promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
          cancel: () => true,
        }),
      },
    })
    const r4 = req()
    cases.push({
      r: r4,
      conn: {
        isPrivateAvailable: () => true,
        privateSessionModelUsageOutcomeWithHandle: () => ({
          id: 4,
          promise: Promise.reject(new Error("Private peer unavailable")),
          cancel: () => true,
        }),
      },
    })
    const r5 = req()
    cases.push({
      r: r5,
      conn: {
        isPrivateAvailable: () => true,
        privateSessionModelUsageOutcomeWithHandle: () => ({
          id: 5,
          promise: new Promise(() => {}),
          cancel: () => true,
        }),
      },
    })
    for (const [i, c] of cases.entries()) {
      const out = await attemptSessionModelUsagePrivate(
        c.conn as never,
        c.r,
        i === 4 ? 10 : 50,
      )
      expect(out.kind).toBe("fallback")
    }
  })

  test("retryable failed falls back", async () => {
    const r = req()
    const connection = {
      isPrivateAvailable: () => true,
      privateSessionModelUsageOutcomeWithHandle: (q: typeof r) => ({
        id: 6,
        promise: Promise.resolve({ kind: "valid", result: retryableFor(q) }),
        cancel: () => true,
      }),
    }
    const out = await attemptSessionModelUsagePrivate(connection as never, r)
    expect(out.kind).toBe("fallback")
  })
})
