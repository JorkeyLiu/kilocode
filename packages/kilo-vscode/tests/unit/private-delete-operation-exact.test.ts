import { describe, expect, it } from "bun:test"
import { tryPrivateDeleteExact, validatePrivateDeleteOperationResult } from "../../src/kilo-provider/session-operation-private"

const SID = "ses_del_client"
const UUID = "123e4567-e89b-12d3-a456-426614174000"
const OP = `delete:${SID}:${UUID}`
const DIR = "/repo"

function readerWith(raw: unknown, calls?: { n: number }) {
  return {
    isEnabled: () => true,
    isStarted: () => true,
    deleteOperation: async () => {
      if (calls) calls.n += 1
      return raw
    },
  } as unknown as never
}

describe("tryPrivateDeleteExact tombstone observation", () => {
  it("found returns with single read, zero SDK", async () => {
    const calls = { n: 0 }
    const reader = readerWith({ v: "1.0", status: "found" }, calls)
    const out = await tryPrivateDeleteExact(reader, { directory: DIR, sessionId: SID, opId: OP })
    expect(out.kind).toBe("found")
    expect(calls.n).toBe(1)
  })

  it("not_found and scope_mismatch are explicit, unavailable on gate-off", async () => {
    const nf = await tryPrivateDeleteExact(readerWith({ v: "1.0", status: "not_found" }), { directory: DIR, sessionId: SID, opId: OP })
    expect(nf.kind).toBe("not_found")
    const sm = await tryPrivateDeleteExact(readerWith({ v: "1.0", status: "scope_mismatch" }), { directory: DIR, sessionId: SID, opId: OP })
    expect(sm.kind).toBe("scope_mismatch")
    const off = await tryPrivateDeleteExact({ isEnabled: () => false, isStarted: () => false } as never, { directory: DIR, sessionId: SID, opId: OP })
    expect(off.kind).toBe("unavailable")
    const missing = await tryPrivateDeleteExact(null, { directory: DIR, sessionId: SID, opId: OP })
    expect(missing.kind).toBe("unavailable")
  })

  it("invalid opId and malformed payload fail closed to unavailable with no prune", async () => {
    const badOp = await tryPrivateDeleteExact(readerWith({ v: "1.0", status: "found" }), { directory: DIR, sessionId: SID, opId: `delete:${SID}:bad` })
    expect(badOp.kind).toBe("unavailable")
    const crossOp = `delete:ses_other:${UUID}`
    const cross = await tryPrivateDeleteExact(readerWith({ v: "1.0", status: "found" }), { directory: DIR, sessionId: SID, opId: crossOp })
    expect(cross.kind).toBe("unavailable")
    const leak = await tryPrivateDeleteExact(readerWith({ v: "1.0", status: "found", code: "x" }), { directory: DIR, sessionId: SID, opId: OP })
    expect(leak.kind).toBe("unavailable")
    const rawLeak = await tryPrivateDeleteExact(readerWith({ v: "1.0", status: "found", message: "x" }), { directory: DIR, sessionId: SID, opId: OP })
    expect(rawLeak.kind).toBe("unavailable")
  })

  it("validate rejects raw code/message/hash and extra keys", async () => {
    expect(() => validatePrivateDeleteOperationResult({ v: "1.0", status: "found" }, SID, OP)).not.toThrow()
    expect(() => validatePrivateDeleteOperationResult({ v: "1.0", status: "found", code: "delete.succeeded" }, SID, OP)).toThrow()
    expect(() => validatePrivateDeleteOperationResult({ v: "1.0", status: "found", message: "m" }, SID, OP)).toThrow()
    expect(() => validatePrivateDeleteOperationResult({ v: "1.0", status: "found", hash: "h" }, SID, OP)).toThrow()
    expect(() => validatePrivateDeleteOperationResult({ v: "1.0", status: "not_found", createdSessionId: "ses_x" }, SID, OP)).toThrow()
  })

  it("throwing reader maps to unavailable with single attempt", async () => {
    const calls = { n: 0 }
    const reader = {
      isEnabled: () => true,
      isStarted: () => true,
      deleteOperation: async () => {
        calls.n += 1
        throw new Error("transport")
      },
    } as unknown as never
    const out = await tryPrivateDeleteExact(reader, { directory: DIR, sessionId: SID, opId: OP })
    expect(out.kind).toBe("unavailable")
    expect(calls.n).toBe(1)
  })
})
