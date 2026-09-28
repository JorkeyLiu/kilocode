import { describe, expect, test } from "bun:test"
import { tryPrivateOperationExact } from "./session-operation-private"

const DIR = "/tmp/ws"
const SES = "ses_abc123"

function readerFor(raw: unknown) {
  return {
    isEnabled: () => true,
    isStarted: () => true,
    list: async () => ({}),
    get: async () => ({}),
    operation: async () => raw,
  }
}

describe("session-operation-private sessionUpdate allowlist", () => {
  test("sessionUpdate:<sessionId>:<token> exact is authoritative, recovery rejected", async () => {
    const opId = `sessionUpdate:${SES}:tok1`
    const found = { v: "1.0", status: "found", operation: { opId, outcome: "succeeded", code: "sessionUpdate.succeeded", message: "ok", time: 1 } }
    const res = await tryPrivateOperationExact(readerFor(found) as never, { directory: DIR, sessionId: SES, opId })
    expect(res.kind).toBe("found")
    const withRecovery = {
      v: "1.0",
      status: "found",
      operation: {
        opId,
        outcome: "failed",
        code: "c",
        message: "m",
        time: 1,
        recovery: { v: 1, owner: "generation", scope: SES, used: 0, limit: 1, terminated: true, nextAt: null, retryOccurrence: null, layer: "restart", closeReason: "crash", replay: false },
      },
    }
    expect(await tryPrivateOperationExact(readerFor(withRecovery) as never, { directory: DIR, sessionId: SES, opId })).toMatchObject({ kind: "unavailable" })
  })

  test("sessionUpdate base form and cross-session binding fail closed", async () => {
    const base = `sessionUpdate:${SES}`
    const rawBase = { v: "1.0", status: "found", operation: { opId: base, outcome: "succeeded", code: "c", message: "m", time: 1 } }
    expect(await tryPrivateOperationExact(readerFor(rawBase) as never, { directory: DIR, sessionId: SES, opId: base })).toMatchObject({ kind: "unavailable" })
    const crossOp = `sessionUpdate:ses_other:tok1`
    const rawCross = { v: "1.0", status: "found", operation: { opId: crossOp, outcome: "succeeded", code: "c", message: "m", time: 1 } }
    expect(await tryPrivateOperationExact(readerFor(rawCross) as never, { directory: DIR, sessionId: SES, opId: crossOp })).toMatchObject({ kind: "unavailable" })
  })

  test("non-allowlisted kinds still fail closed", async () => {
    for (const opId of ["create:tok1", "delete:ses_abc:tok1", "sessionUpdate:ses_abc:tok:with:colon"]) {
      const raw = { v: "1.0", status: "found", operation: { opId, outcome: "succeeded", code: "c", message: "m", time: 1 } }
      const res = await tryPrivateOperationExact(readerFor(raw) as never, { directory: DIR, sessionId: "ses_abc", opId })
      expect(res.kind).toBe("unavailable")
    }
  })
})
