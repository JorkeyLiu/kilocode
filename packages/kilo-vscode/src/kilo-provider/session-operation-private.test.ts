import { describe, expect, test } from "bun:test"
import { tryPrivateOperationExact, validatePrivateOperationResult } from "./session-operation-private"

const DIR = "/tmp/ws"
const SES = "ses_abc123"
const OP = "prompt:msg_1"

function found(opId = OP, outcome = "in-flight") {
  return { v: "1.0", status: "found", operation: { opId, outcome, code: "prompt.inflight", message: "prompt accepted", time: 1 } }
}

function readerFor(raw: unknown, enabled = true, started = true) {
  return {
    isEnabled: () => enabled,
    isStarted: () => started,
    list: async () => ({}),
    get: async () => ({}),
    operation: async () => raw,
  }
}

describe("session-operation-private exact", () => {
  test("found in-flight is authoritative", async () => {
    const res = await tryPrivateOperationExact(readerFor(found()) as never, { directory: DIR, sessionId: SES, opId: OP })
    expect(res.kind).toBe("found")
    if (res.kind === "found") expect(res.operation.opId).toBe(OP)
  })

  test("not_found and scope_mismatch are terminal with zero SDK", async () => {
    for (const status of ["not_found", "scope_mismatch"]) {
      const res = await tryPrivateOperationExact(readerFor({ v: "1.0", status }) as never, { directory: DIR, sessionId: SES, opId: OP })
      expect(res.kind).toBe("terminal")
    }
  })

  test("gate-off and throw return unavailable with zero SDK", async () => {
    const off = await tryPrivateOperationExact(readerFor(found(), false, true) as never, { directory: DIR, sessionId: SES, opId: OP })
    expect(off.kind).toBe("unavailable")
    const throwing = {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({}),
      get: async () => ({}),
      operation: async () => { throw new Error("Peer closed") },
    }
    const res = await tryPrivateOperationExact(throwing as never, { directory: DIR, sessionId: SES, opId: OP })
    expect(res.kind).toBe("unavailable")
  })

  test("malformed and opId mismatch fail closed to unavailable", async () => {
    const bad = await tryPrivateOperationExact(readerFor({ v: "1.0", status: "found", operation: { opId: OP, outcome: "in-flight" } }) as never, { directory: DIR, sessionId: SES, opId: OP })
    expect(bad.kind).toBe("unavailable")
    const mismatch = await tryPrivateOperationExact(readerFor(found("prompt:msg_other")) as never, { directory: DIR, sessionId: SES, opId: OP })
    expect(mismatch.kind).toBe("unavailable")
  })

  test("diagnostic leak fails closed", async () => {
    const leaked = { v: "1.0", status: "found", operation: { opId: OP, outcome: "in-flight", code: "c", message: "m", time: 1, detail: "secret" } }
    const res = await tryPrivateOperationExact(readerFor(leaked) as never, { directory: DIR, sessionId: SES, opId: OP })
    expect(res.kind).toBe("unavailable")
  })

  test("recovery scope must equal session", async () => {
    const rec = {
      v: "1.0",
      status: "found",
      operation: {
        opId: OP,
        outcome: "failed",
        code: "E",
        message: "m",
        time: 1,
        recovery: { v: 1, owner: "generation", scope: "ses_other", used: 0, limit: 1, terminated: false, nextAt: null, retryOccurrence: null, layer: null, closeReason: null, replay: false },
      },
    }
    const res = await tryPrivateOperationExact(readerFor(rec) as never, { directory: DIR, sessionId: SES, opId: OP })
    expect(res.kind).toBe("unavailable")
    const good = {
      v: "1.0",
      status: "found",
      operation: {
        opId: OP,
        outcome: "failed",
        code: "E",
        message: "m",
        time: 1,
        recovery: { v: 1, owner: "generation", scope: SES, used: 0, limit: 1, terminated: true, nextAt: null, retryOccurrence: null, layer: "restart", closeReason: "crash", replay: false },
      },
    }
    const ok = validatePrivateOperationResult(good, DIR, SES, OP)
    expect(ok.status).toBe("found")
  })

  test("revert and unrevert exact session-bound ops are authoritative", async () => {
    const rop = `revert:${SES}:tok1`
    const uop = `unrevert:${SES}:tok2`
    const rfound = { v: "1.0", status: "found", operation: { opId: rop, outcome: "succeeded", code: "revert.succeeded", message: "revert succeeded", time: 1 } }
    const ufound = { v: "1.0", status: "found", operation: { opId: uop, outcome: "succeeded", code: "unrevert.succeeded", message: "unrevert succeeded", time: 1 } }
    const r = await tryPrivateOperationExact(readerFor(rfound) as never, { directory: DIR, sessionId: SES, opId: rop })
    expect(r.kind).toBe("found")
    const u = await tryPrivateOperationExact(readerFor(ufound) as never, { directory: DIR, sessionId: SES, opId: uop })
    expect(u.kind).toBe("found")
  })

  test("revert with recovery or wrong session binding fails closed", async () => {
    const rop = `revert:${SES}:tok1`
    const leaked = { v: "1.0", status: "found", operation: { opId: rop, outcome: "failed", code: "c", message: "m", time: 1, recovery: { v: 1, owner: "generation", scope: SES, used: 0, limit: 1, terminated: true, nextAt: null, retryOccurrence: null, layer: "restart", closeReason: "crash", replay: false } } }
    expect(await tryPrivateOperationExact(readerFor(leaked) as never, { directory: DIR, sessionId: SES, opId: rop })).toMatchObject({ kind: "unavailable" })
    const cross = { v: "1.0", status: "found", operation: { opId: `revert:ses_other:tok1`, outcome: "succeeded", code: "c", message: "m", time: 1 } }
    expect(await tryPrivateOperationExact(readerFor(cross) as never, { directory: DIR, sessionId: SES, opId: `revert:ses_other:tok1` })).toMatchObject({ kind: "unavailable" })
  })

  test("fork exact session-bound op is authoritative with optional child, recovery rejected", async () => {
    const opId = "fork:ses_abc:tok1"
    const found = { v: "1.0", status: "found", operation: { opId, outcome: "succeeded", code: "fork.succeeded", message: "fork succeeded", time: 1 } }
    expect(await tryPrivateOperationExact(readerFor(found) as never, { directory: DIR, sessionId: "ses_abc", opId })).toMatchObject({ kind: "found" })
    const withChild = { v: "1.0", status: "found", operation: { opId, outcome: "succeeded", code: "fork.succeeded", message: "fork succeeded", time: 1, forkedSessionId: "ses_child1" } }
    expect(await tryPrivateOperationExact(readerFor(withChild) as never, { directory: DIR, sessionId: "ses_abc", opId })).toMatchObject({ kind: "found" })
    const withRecovery = { v: "1.0", status: "found", operation: { opId, outcome: "failed", code: "c", message: "m", time: 1, recovery: { v: 1, owner: "generation", scope: "ses_abc", used: 0, limit: 1, terminated: true, nextAt: null, retryOccurrence: null, layer: "restart", closeReason: "crash", replay: false } } }
    expect(await tryPrivateOperationExact(readerFor(withRecovery) as never, { directory: DIR, sessionId: "ses_abc", opId })).toMatchObject({ kind: "unavailable" })
    const badChild = { v: "1.0", status: "found", operation: { opId, outcome: "failed", code: "c", message: "m", time: 1, forkedSessionId: "ses_child1" } }
    expect(await tryPrivateOperationExact(readerFor(badChild) as never, { directory: DIR, sessionId: "ses_abc", opId })).toMatchObject({ kind: "unavailable" })
    const selfChild = { v: "1.0", status: "found", operation: { opId, outcome: "succeeded", code: "c", message: "m", time: 1, forkedSessionId: "ses_abc" } }
    expect(await tryPrivateOperationExact(readerFor(selfChild) as never, { directory: DIR, sessionId: "ses_abc", opId })).toMatchObject({ kind: "unavailable" })
  })

  test("non-prompt non-checkpoint kinds fail closed", async () => {
    for (const opId of ["create:tok1", "delete:ses_abc:tok1", "task:ses_abc"]) {
      const raw = { v: "1.0", status: "found", operation: { opId, outcome: "succeeded", code: "c", message: "m", time: 1 } }
      const res = await tryPrivateOperationExact(readerFor(raw) as never, { directory: DIR, sessionId: "ses_abc", opId })
      expect(res.kind).toBe("unavailable")
    }
  })
})
